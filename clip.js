// ClipTweet — client-side clip pipeline.
// Extracts post metadata via the stateless resolver, then decodes, composites
// and re-encodes the MP4 entirely in the browser. No server video processing.

import {
  Input, Output, Conversion, Mp4OutputFormat, BufferTarget,
  UrlSource, ALL_FORMATS, Quality, canEncodeVideo,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.61.0/+esm';

const MAX_BYTES = 20 * 1024 * 1024;   // hard download cap
const HEADROOM = 0.90;                 // container / audio overhead margin
const MAX_DURATION_SEC = 600;

// Banner colours match the previous server-rendered header.
const BANNER_BG = '#15202B';
const BANNER_FG = '#FFFFFF';
// Same stack as the app UI. The bare `sans-serif` keyword resolves to a
// bitmap-style font on some systems, which is what made the banner look 8-bit.
const BANNER_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
// Banner spec. Each tier pins the font to its own reference width so the text
// keeps a constant share of the frame no matter how wide the frame ends up:
// `fontPx / outW` is the same for every width, so raising the composition
// floor to sharpen the text does not shrink it. Standard output uses the
// original 1280px-wide reference.
const BANNER_SPEC = { standard: { refW: 1280, fontPx: 58, lineHeight: 76, padY: 46 } };
const MIN_FONT_PX = 18;
const TEXT_SCALE = 2;

// `minWidth` is the composition floor: a frame narrower than the display size
// gets upscaled by the browser, and the upscaled banner text is what looked
// 8-bit. Standard output has no floor, so its output stays sharp.
const PROFILE = { width: 1280, minWidth: 0, maxVideoKbps: 5000, audioKbps: 128 };

// ── URL normalisation (fixes the paste-link failure) ─────────────────────────

export function normalizeTweetUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a valid URL.');

  // Pull the first http(s) token out of whatever was pasted (share text, quotes...).
  const match = raw.match(/https?:\/\/[^\s<>"']+/i) || (/^[^\s/]+\.[^\s/]+\/\S*$/i.test(raw) ? [raw] : null);
  if (!match) {
    throw new Error('That does not look like a link. Paste the X/Twitter post URL.');
  }
  let candidate = match[0].replace(/[),.;:'"]+$/, '');
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate.replace(/^\/+/, '');

  let u;
  try { u = new URL(candidate); }
  catch { throw new Error('That link is not a valid URL.'); }

  if (u.protocol !== 'https:') {
    throw new Error('Only https:// X or Twitter links are supported.');
  }
  const host = u.hostname.toLowerCase();
  if (!/^(www\.|mobile\.)?(x|twitter)\.com$/.test(host)) {
    throw new Error('Only x.com and twitter.com post links are supported.');
  }
  const m = u.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/(?:web\/)?status)\/(\d{5,25})\/?$/);
  if (!m) {
    throw new Error('That link does not point to a post. Use a link like https://x.com/user/status/1234567890');
  }
  return { statusId: m[1], canonical: `https://x.com/i/status/${m[1]}` };
}

// ── Text layout ──────────────────────────────────────────────────────────────

const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function graphemes(text) {
  if (graphemeSegmenter) return [...graphemeSegmenter.segment(text)].map(x => x.segment);
  return Array.from(text);
}

function isEmojiCluster(cluster) {
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3|\ufe0f/u.test(cluster);
}

function emojiCodepoints(cluster) {
  return [...cluster].map(ch => ch.codePointAt(0).toString(16)).join('-');
}

function visualWidth(ctx, text, emojiPx) {
  return graphemes(text).reduce((width, cluster) =>
    width + (isEmojiCluster(cluster) ? emojiPx : ctx.measureText(cluster).width), 0);
}

function layoutLines(ctx, text, maxWidth, emojiPx) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let current = '';
    // filter(Boolean) drops the empty strings produced by runs of spaces, so a
    // paragraph never renders with a ragged leading gap.
    for (const word of paragraph.split(' ').filter(Boolean)) {
      const test = current ? current + ' ' + word : word;
      if (current && visualWidth(ctx, test, emojiPx) > maxWidth) { lines.push(current); current = word; }
      else current = test;
    }
    if (current) lines.push(current);
  }
  return lines;
}

async function loadEmojiAssets(lines, size, signal) {
  const cache = new Map();
  const clusters = lines.flatMap(line => graphemes(line)).filter(isEmojiCluster);
  await Promise.all([...new Set(clusters)].map(async cluster => {
    const codepoints = emojiCodepoints(cluster);
    const assetUrl = `https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/${codepoints}.svg`;
    try {
      const response = await fetch(assetUrl, { mode: 'cors', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) throw new Error(`emoji asset ${response.status}`);
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const image = new Image();
      image.src = dataUrl;
      await abortable(image.decode(), AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
      cache.set(cluster, image);
    } catch {
      /* native Canvas fallback */
    }
  }));
  return cache;
}

function drawVisualLine(ctx, line, centerX, y, maxWidth, emojiPx, assets, middle = false) {
  const clusters = graphemes(line);
  const parts = [];
  for (const cluster of clusters) {
    if (isEmojiCluster(cluster) || !parts.length || parts.at(-1).emoji) parts.push({ value: cluster, emoji: isEmojiCluster(cluster) });
    else parts.at(-1).value += cluster;
  }
  const width = visualWidth(ctx, line, emojiPx);
  let x = centerX - width / 2;
  const previousAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const part of parts) {
    const partWidth = part.emoji ? emojiPx : ctx.measureText(part.value).width;
    const image = assets.get(part.value);
    if (image) {
      ctx.drawImage(image, x, middle ? y - emojiPx / 2 : y, emojiPx, emojiPx);
    } else if (middle) {
      ctx.strokeText(part.value, x, y);
      ctx.fillText(part.value, x, y);
    } else {
      ctx.fillText(part.value, x, y);
    }
    x += partWidth;
  }
  ctx.textAlign = previousAlign;
}

export function cleanText(text) {
  return String(text || '')
    // Strip every link form, not just t.co: posts routinely carry
    // https://t.co/<code> (codes may contain "-" and "_"), pic.twitter.com/<code>
    // and plain https:// links in their body text. Anything left here renders
    // as noise in the banner.
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\b(?:t\.co|pic\.twitter\.com|x\.com|twitter\.com|mobile\.twitter\.com)\/\S+/gi, '')
    .replace(/^(\s*@[\w.]+\s*)+/, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    // Collapse horizontal whitespace only. Newlines are load-bearing here and
    // must survive.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[ ]*\n[ ]*/g, '\n')
    .replace(/^[^\S\n]+|[^\S\n]+$/g, '')
    .trim();
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/g;
function sanitizeDisplayName(value) {
  const text = String(value || '').replace(CONTROL_RE, '').replace(BIDI_RE, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, 30).join('');
}
async function buildIdentityBlock(dataUrl, name, fontPx, maxWidth) {
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(String(dataUrl || '')) && !/^https:\/\//i.test(String(dataUrl || ''))) return null;
  const response = await fetch(dataUrl);
  const bitmap = await createImageBitmap(await response.blob());
  const diameter = Math.min(Math.round(fontPx * 2.25), bitmap.width, bitmap.height);
  if (diameter < 2) { bitmap.close(); return null; }
  const gap = Math.round(diameter * .4), namePx = Math.max(12, Math.round(fontPx * .88));
  const canvas = document.createElement('canvas'); canvas.width = maxWidth; canvas.height = diameter;
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.save(); ctx.beginPath(); ctx.arc(diameter / 2, diameter / 2, diameter / 2, 0, Math.PI * 2); ctx.clip();
  const scale = Math.max(diameter / bitmap.width, diameter / bitmap.height);
  const w = bitmap.width * scale, h = bitmap.height * scale;
  ctx.drawImage(bitmap, (diameter - w) / 2, (diameter - h) / 2, w, h); ctx.restore();
  ctx.font = `700 ${namePx}px ${BANNER_FONT_FAMILY}`; ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  let label = name; while (label && ctx.measureText(label).width > maxWidth - diameter - gap) label = `${label.slice(0, -1).trim()}…`;
  ctx.fillText(label, diameter + gap, diameter / 2); return { canvas, diameter, height: diameter, bitmap };
}

// ── Main pipeline ────────────────────────────────────────────────────────────

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Generation canceled.', 'AbortError'));
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function generateClip(options) {
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error('Generation timed out. Try a shorter video.')), 600_000);
  try { return await abortable(generateClipInternal({ ...options, signal: controller.signal,
    onProgress: (...args) => { if (!controller.signal.aborted) options.onProgress?.(...args); },
  }), controller.signal); }
  catch (error) {
    if (error.name === 'TimeoutError') throw new Error('Video request timed out. Check your connection and try again.');
    throw error;
  }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}

async function generateClipInternal({ url, version = 'standard', identity, onProgress, signal }) {
  if (!['standard', 'reel'].includes(version)) throw new Error('Choose a supported video layout.');
  const isReel = version === 'reel';
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser cannot encode video. Update to a recent Chrome, Edge or Safari 16.4+.');
  }

  const { statusId, canonical } = normalizeTweetUrl(url);
  onProgress?.('Looking up the post...', 0.02);

  const apiBase = String(globalThis.CLIPTWEET_API_BASE || '').replace(/\/$/, '');
  const res = await fetch(`${apiBase}/api/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Send the canonical URL, never the raw paste: the worker only accepts
    // fully-formed https X/Twitter links.
    body: JSON.stringify({ url: canonical }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not read that post.');
  if (statusId && data.id && data.id !== statusId) {
    throw new Error('That link no longer matches the post. Copy the link again.');
  }

  const profile = PROFILE;
  const durationSec = (data.durationMs || 0) / 1000;
  if (durationSec > MAX_DURATION_SEC) {
    throw new Error('That video is longer than 10 minutes.');
  }
  if (!durationSec) throw new Error('Could not determine the video duration.');

  const variant = data.variants.at(-1);
  if (!variant) throw new Error('That post has no playable video.');

  // Duration-aware bitrate budget with headroom, so the result cannot exceed
  // Keep generated files within 20 MB.
  const totalKbps = (MAX_BYTES * 8 * HEADROOM) / durationSec / 1000;
  const audioKbps = profile.audioKbps;
  let videoKbps = Math.floor(Math.min(totalKbps - audioKbps, profile.maxVideoKbps));
  if (videoKbps < 60) {
    throw new Error('That video is too long to fit in the 20 MB limit at a usable quality.');
  }

  onProgress?.('Downloading the video...', 0.06);

  // X's CDN answers 403 to any request that carries a Referer header, so the
  // media fetch must not send one. This is a hotlink-protection rule, not a
  // CORS rule — CORS itself is open and the request is cross-origin either way.
  const source = new UrlSource(variant.url, {
    requestInit: { referrerPolicy: 'no-referrer' },
    getRetryDelay: attempts => attempts < 3 ? 1 : null,
  });
  const input = new Input({ formats: ALL_FORMATS, source });
  let conversion;
  const stop = () => { void conversion?.cancel().catch(() => {}); try { input.dispose(); } catch {} };
  signal.addEventListener('abort', stop, { once: true });

  try {
    const videoTrack = await abortable(input.getPrimaryVideoTrack(), AbortSignal.any([signal, AbortSignal.timeout(45_000)]));
    if (!videoTrack) throw new Error('That post has no video track.');

    const [srcW, srcH] = await abortable(Promise.all([videoTrack.getDisplayWidth(), videoTrack.getDisplayHeight()]), AbortSignal.any([signal, AbortSignal.timeout(45_000)]));
    // Even width/height keeps H.264 encoders happy.
    const outW = Math.max(2, isReel ? srcW : Math.min(profile.width, srcW)) & ~1;
    const outH = Math.max(2, Math.round(outW * (srcH / srcW)) & ~1);

    // Banner metrics scale with the frame, so the text keeps the same share of
    // the width and the same on-screen size as the 320px-era original.
  const spec = BANNER_SPEC.standard;
    const scale = outW / spec.refW;
    const fontPx = Math.max(MIN_FONT_PX, Math.round(spec.fontPx * scale));
    const lineHeight = Math.round(spec.lineHeight * scale);
    const padY = Math.round(spec.padY * scale);
    const padX = Math.max(10, Math.floor(outW * 0.04));
    // Must be the exact font the banner draws with, otherwise measureText()
    // reports widths that do not match the rendered glyphs and the last word
    // of a line can spill past the padding.
    const font = `400 ${fontPx}px ${BANNER_FONT_FAMILY}`;
    const measurer = document.createElement('canvas').getContext('2d');
    measurer.font = font;
    // The banner renders the post's own prose only: links, t.co codes and
    // leading mentions are stripped before layout.
    const bannerText = cleanText(data.text);
    let lines = bannerText ? layoutLines(measurer, bannerText, outW - padX * 2, fontPx) : [];
    let reelFontPx = Math.max(14, Math.round(outW * 0.05));
    if (isReel) {
      for (;;) {
        measurer.font = `800 ${reelFontPx}px ${BANNER_FONT_FAMILY}`;
        lines = bannerText ? layoutLines(measurer, bannerText, outW * 0.9, reelFontPx) : [];
        if (reelFontPx <= 14 || lines.length * reelFontPx * 1.2 <= outH / 6) break;
        reelFontPx--;
      }
    }
    // A post that is nothing but a link yields no prose, so no banner at all
    // rather than an empty black bar.
    const identityName = !isReel ? sanitizeDisplayName(identity?.name) : '';
    const identityBlock = identityName && identity?.avatar ? await buildIdentityBlock(identity.avatar, identityName, fontPx, outW - padX * 2) : null;
    const identityGap = identityBlock ? Math.round(lineHeight * .5) : 0;
    const textTop = identityBlock ? padY + identityBlock.height + identityGap : padY;
    const bannerH = !isReel && (lines.length || identityBlock) ? Math.ceil(padY * 2 + (identityBlock ? identityBlock.height + identityGap : 0) + lines.length * lineHeight) : 0;
    const totalH = bannerH + outH;
    const reelStep = reelFontPx * 1.2;
    const reelStartY = Math.max(reelStep / 2, Math.min(outH * 5 / 6 - (lines.length - 1) * reelStep / 2, outH - (lines.length - 0.5) * reelStep));
    const reelStrokeWidth = Math.max(2, reelFontPx * 0.14);
    const reelMetrics = isReel ? lines.map(line => measurer.measureText(line)) : [];
    const reelAscent = Math.max(reelFontPx, ...reelMetrics.map(metric => metric.actualBoundingBoxAscent || 0));
    const reelDescent = Math.max(reelFontPx * 0.3, ...reelMetrics.map(metric => metric.actualBoundingBoxDescent || 0));
    const reelPad = Math.ceil(reelStrokeWidth / 2 + 2);
    const reelTop = isReel ? Math.max(0, Math.floor(reelStartY - reelAscent - reelPad)) : 0;
    const reelBottom = isReel ? Math.min(outH, Math.ceil(reelStartY + Math.max(0, lines.length - 1) * reelStep + reelDescent + reelPad)) : 0;
    const reelLayerH = Math.max(1, reelBottom - reelTop);
    const emojiAssets = await abortable(loadEmojiAssets(lines, isReel ? reelFontPx : fontPx, signal), signal);

    // Draw the banner once into a reusable offscreen bitmap.
    const banner = document.createElement('canvas');
    banner.width = outW * TEXT_SCALE; banner.height = (isReel ? reelLayerH : bannerH) * TEXT_SCALE;
    const bctx = banner.getContext('2d');
    bctx.scale(TEXT_SCALE, TEXT_SCALE);
    if (!isReel) { bctx.fillStyle = BANNER_BG; bctx.fillRect(0, 0, outW, bannerH); if (identityBlock) bctx.drawImage(identityBlock.canvas, padX, padY); }
    bctx.fillStyle = BANNER_FG;
    bctx.font = font;
    bctx.textAlign = 'center'; bctx.textBaseline = 'top';
    // A tight shadow firms up the glyph edges once the frame is scaled down for
    // display, without changing the flat two-tone look.
    bctx.shadowColor = 'rgba(0,0,0,0.45)';
    bctx.shadowBlur = Math.max(1, fontPx / 10);
    bctx.shadowOffsetY = Math.max(1, Math.round(fontPx / 24));
    if (isReel) {
      bctx.font = `800 ${reelFontPx}px ${BANNER_FONT_FAMILY}`;
      bctx.textBaseline = 'middle';
      bctx.shadowColor = 'transparent';
      bctx.strokeStyle = '#000';
      bctx.lineJoin = 'round';
      bctx.lineWidth = reelStrokeWidth;
      lines.forEach((line, i) => {
        const y = reelStartY - reelTop + i * reelStep;
        drawVisualLine(bctx, line, outW / 2, y, outW * 0.9, reelFontPx, emojiAssets, true);
      });
    } else lines.forEach((line, i) => drawVisualLine(bctx, line, outW / 2, textTop + i * lineHeight, outW - padX * 2, fontPx, emojiAssets));
    identityBlock?.bitmap.close?.();
    bctx.shadowColor = 'transparent';
    bctx.shadowBlur = 0;
    bctx.shadowOffsetY = 0;

    const frame = document.createElement('canvas');
    frame.width = outW; frame.height = totalH;
    const fctx = frame.getContext('2d', { alpha: false });
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = 'high';

    onProgress?.('Encoding your clip...', 0.15);

    const codecOrder = ['avc', 'vp9', 'av1', 'vp8'];

    // An MP4 holding only an audio track is technically valid, so `isValid`
    // alone is not enough: if the video track gets discarded (undecodable or
    // unencodable on this device) the conversion still "succeeds" and hands the
    // user an audio-only file. Require a video track in the output, and fall
    // back through the remaining codecs before giving up.
    let output;
    for (let sizeAttempt = 0; sizeAttempt < 2; sizeAttempt++) {
    conversion = undefined;
    for (const codec of codecOrder) {
      let encodable = false;
      try { encodable = await abortable(canEncodeVideo(codec, { width: outW, height: totalH }), AbortSignal.any([signal, AbortSignal.timeout(45_000)])); }
      catch { encodable = false; }
      if (!encodable) continue;

      const candidateOutput = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
      const attempt = await abortable(Conversion.init({
        input, output: candidateOutput,
        video: {
          codec,
          forceTranscode: true,
          // No `width` option: process() already returns a frame at the final
          // output size, so any automatic resize stage would rescale the banner.
          quality: new Quality({ bitrate: Math.round(videoKbps * 1000) }),
          process: (sample) => {
            if (!isReel && bannerH) fctx.drawImage(banner, 0, 0, outW, bannerH);
            // Explicit size: the video is scaled to the final frame, so the
            // banner above is never resampled and the text stays crisp.
            sample.draw(fctx, 0, bannerH, outW, outH);
            if (isReel && lines.length) fctx.drawImage(banner, 0, reelTop, outW, reelLayerH);
            return frame;
          },
          processedWidth: outW,
          processedHeight: totalH,
        },
        // No audio options: the X source is already AAC, so Mediabunny copies
        // the track untouched. Forcing a transcode here silently dropped audio
        // on devices without an encoder for the source's channel/rate pairing.
      }), AbortSignal.any([signal, AbortSignal.timeout(45_000)]));

      const discarded = attempt.discardedTracks.map((d) => `${d.track.type}:${d.reason}`);
      if (discarded.length) console.warn(`clip: discarded tracks (${codec}) — ${discarded.join(', ')}`);

      if (attempt.isValid && attempt.utilizedTracks.some((t) => t.type === 'video')) {
        output = candidateOutput;
        conversion = attempt;
        break;
      }
      await attempt.cancel().catch(() => {});
    }

    if (!conversion) {
      throw new Error('This device could not encode the video track. Try Chrome, Edge or Safari 16.4+ on a computer.');
    }

    let lastProgress = performance.now();
    let previousProgress = -1;
    const stallController = new AbortController();
    conversion.onProgress = (p) => {
      if (p > previousProgress) { lastProgress = performance.now(); previousProgress = p; }
      onProgress?.(`${sizeAttempt ? 'Fitting clip to 20 MB' : 'Encoding your clip'}... ${Math.round(p * 100)}%`, 0.15 + p * 0.8);
    };
    const stalled = setInterval(() => {
      if (performance.now() - lastProgress > 60_000) {
        stallController.abort(new Error('Video processing stopped responding. Try again or use a shorter video.'));
        stop();
      }
    }, 5000);
    try { await abortable(conversion.execute(), AbortSignal.any([signal, stallController.signal])); }
    catch (error) {
      if (performance.now() - lastProgress > 60_000) throw new Error('Video processing stopped responding. Try again or use a shorter video.');
      throw error;
    } finally { clearInterval(stalled); }

    const buffer = output.target.buffer;
    const blob = new Blob([buffer], { type: 'video/mp4' });

    // Safety net: never expose an oversized result.
    if (blob.size > MAX_BYTES) {
      if (sizeAttempt === 0) {
        console.info('clip: fitting oversized VBR output', { bytes: blob.size, videoKbps, durationSec });
        videoKbps = Math.max(60, Math.floor((videoKbps + audioKbps) * MAX_BYTES / blob.size * 0.85 - audioKbps));
        onProgress?.('Fitting clip to the 20 MB download limit...', 0.15);
        continue;
      }
      throw new Error('That video is too long to fit in the 20 MB limit. Try a shorter post.');
    }
    return { blob, text: bannerText, lines, author: data.author, handle: data.handle };
    }
  } finally {
    signal.removeEventListener('abort', stop);
    void conversion?.cancel().catch(() => {});
    try { input.dispose(); } catch { /* already gone */ }
  }
}
