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
const STANDARD_SURFACE = '#15202B';
const BANNER_BG = STANDARD_SURFACE;
const BANNER_FG = '#FFFFFF';
// Same stack as the app UI. The bare `sans-serif` keyword resolves to a
// bitmap-style font on some systems, which is what made the banner look 8-bit.
const BANNER_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
// Banner spec. Each tier pins the font to its own reference width so the text
// keeps a constant share of the frame no matter how wide the frame ends up:
// `fontPx / outW` is the same for every width, so raising the composition
// floor to sharpen the text does not shrink it. Standard output uses the
// original 1280px-wide reference.
const BANNER_SPEC = { standard: { refW: 1280, fontPx: 58, lineHeight: 82, padY: 46 } };
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

function layoutLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let current = '';
    // filter(Boolean) drops the empty strings produced by runs of spaces, so a
    // paragraph never renders with a ragged leading gap.
    for (const word of paragraph.split(' ').filter(Boolean)) {
      const test = current ? current + ' ' + word : word;
      if (current && ctx.measureText(test).width > maxWidth) { lines.push(current); current = word; }
      else current = test;
    }
    if (current) lines.push(current);
  }
  return lines;
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

// ── Display name (identity block) ────────────────────────────────────────────

// Bidi controls can visually reorder the label; C0/C1 controls can break the
// line box. Both are stripped before the name ever reaches the canvas.
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g;
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const MAX_NAME_GRAPHEMES = 30;

export function sanitizeDisplayName(input) {
  const flattened = String(input == null ? '' : input)
    .replace(CONTROL_RE, ' ')
    .replace(BIDI_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, ' ')      // a name is a single line
    .replace(/\s+/g, ' ')    // collapse
    .trim();
  if (!flattened) return '';
  // Grapheme-based so an emoji is never cut in half.
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const out = [];
    for (const { segment } of segmenter.segment(flattened)) {
      if (out.length >= MAX_NAME_GRAPHEMES) return out.join('') + '…';
      out.push(segment);
    }
    return out.join('');
  }
  return [...flattened].slice(0, MAX_NAME_GRAPHEMES).join('') +
    (Array.from(flattened).length > MAX_NAME_GRAPHEMES ? '…' : '');
}

// Builds the avatar + name strip exactly once, before the encoding loop, so the
// per-frame cost stays a single drawImage of an already-rendered bitmap. The
// avatar is cover-cropped into a circle at its final size: never upscaled.
// Decodes the inline avatar the resolver returned. Done in memory rather than
// with fetch() because the site CSP does not list data: in connect-src, and
// this avoids a network round trip for a few kilobytes.
async function decodeAvatarDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) throw new Error('Unsupported profile picture.');
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return createImageBitmap(new Blob([bytes], { type: match[1] }));
}

async function buildIdentityBlock(avatarUrl, label, fontPx, maxWidth) {
  const bitmap = await decodeAvatarDataUrl(avatarUrl);
  try {
    let diameter = Math.round(fontPx * 2.25);
    if (bitmap.width < diameter) diameter = bitmap.width;   // never upscale
    const gap = Math.round(diameter * 0.4);                // avatar to name
    let nameFontPx = Math.max(12, Math.round(fontPx * 0.88));
    const textWidth = Math.max(1, maxWidth - diameter - gap);

    // The name is centred with the avatar, so its own width decides the strip.
    const measurer = document.createElement('canvas').getContext('2d');
    const weight = fontPx >= 40 ? '600' : '700';
    measurer.font = `${weight} ${nameFontPx}px ${BANNER_FONT_FAMILY}`;
    let text = label;
    if (measurer.measureText(text).width > textWidth) {
      // Shrink before truncating, and never let the glyphs overflow the box.
      while (nameFontPx > 12 && measurer.measureText(text).width > textWidth) {
        nameFontPx -= 1;
        measurer.font = `${weight} ${nameFontPx}px ${BANNER_FONT_FAMILY}`;
      }
      if (measurer.measureText(text).width > textWidth) {
        while (text.length > 1 && measurer.measureText(text + '…').width > textWidth) {
          text = text.slice(0, -1);
        }
        text += '…';
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = maxWidth;
    canvas.height = diameter;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Cover crop keeps the aspect ratio and fills the circle.
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(diameter / 2, diameter / 2, diameter / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, diameter, diameter);
    ctx.restore();

    const blockTop = Math.round((diameter - nameFontPx) / 2);
    const textX = diameter + gap;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `${weight} ${nameFontPx}px ${BANNER_FONT_FAMILY}`;
    ctx.fillStyle = BANNER_FG;
    ctx.fillText(text, textX, blockTop + nameFontPx / 2, textWidth);

    return { canvas, diameter, height: diameter, bitmap };
  } catch (error) {
    bitmap.close?.();
    throw error;
  }
}

// ── Main pipeline ────────────────────────────────────────────────────────────

export async function generateClip({ url, identity, version = 'standard', branding = true, onProgress, signal }) {
  if (!['standard', 'reel'].includes(version)) throw new Error('Choose a supported video layout.');
  const isReel = version === 'reel';
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser cannot encode video. Update to a recent Chrome, Edge or Safari 16.4+.');
  }

  const { statusId, canonical } = normalizeTweetUrl(url);
  onProgress?.('Looking up the post...', 0.02);

  const apiBase = String(globalThis.CLIPTWEET_API_BASE || '').replace(/\/$/, '');
  const resolveUrl = `${apiBase}/api/resolve`;
  const resolveOptions = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Send the canonical URL, never the raw paste: the worker only accepts
    // fully-formed https X/Twitter links.
    body: JSON.stringify({ url: canonical }),
    signal,
  };
  let res;
  try {
    res = await fetch(resolveUrl, resolveOptions);
  } catch (err) {
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not read that post.');
  if (statusId && data.id && data.id !== statusId) {
    throw new Error('That link no longer matches the post. Copy the link again.');
  }

  const profile = PROFILE;
  const variant = data.variants.at(-1);
  if (!variant) throw new Error('That post has no playable video.');

  // Duration-aware bitrate budget with headroom, so the result cannot exceed
  // Keep generated files within 20 MB.
  onProgress?.('Downloading the video...', 0.06);

  // X's CDN answers 403 to any request that carries a Referer header, so the
  // media fetch must not send one. This is a hotlink-protection rule, not a
  // CORS rule — CORS itself is open and the request is cross-origin either way.
  const source = new UrlSource(variant.url, { requestInit: { referrerPolicy: 'no-referrer' } });
  const input = new Input({ formats: ALL_FORMATS, source });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('That post has no video track.');

    // X animated GIF posts are exposed as silent MP4 variants. When X omits
    // duration_millis, read duration from the normalized MP4 track itself.
    let durationSec = Number(data.durationMs || 0) / 1000;
    if (!durationSec) {
      durationSec = Number(await videoTrack.computeDuration?.() || 0);
    }
    if (durationSec > MAX_DURATION_SEC) throw new Error('That video is longer than 10 minutes.');
    if (!durationSec) throw new Error('Could not determine the video duration.');
    const totalKbps = (MAX_BYTES * 8 * HEADROOM) / durationSec / 1000;
    const audioKbps = profile.audioKbps;
    const videoKbps = Math.floor(Math.min(totalKbps - audioKbps, profile.maxVideoKbps));
    if (videoKbps < 60) throw new Error(`That video exceeds the ${MAX_BYTES / (1024 * 1024)} MB size limit. Try a shorter or lower-quality video.`);

    const srcW = await videoTrack.getDisplayWidth();
    const srcH = await videoTrack.getDisplayHeight();
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
    let lines = bannerText ? layoutLines(measurer, bannerText, outW - padX * 2) : [];
    let reelFontPx = Math.max(14, Math.round(outW * 0.05));
    if (isReel) {
      for (;;) {
        measurer.font = `800 ${reelFontPx}px ${BANNER_FONT_FAMILY}`;
        lines = bannerText ? layoutLines(measurer, bannerText, outW * 0.9) : [];
        if (reelFontPx <= 14 || lines.length * reelFontPx * 1.2 <= outH / 6) break;
        reelFontPx--;
      }
    }
    // A post that is nothing but a link yields no prose, so no banner at all
    // rather than an empty black bar.
    // Optional identity block above the post text. Without it, only the shared
    // Standard typography metrics determine the banner height.
    const name = isReel ? '' : sanitizeDisplayName(identity?.name);
    const hasIdentity = !!(name && identity?.avatar);
    const identityBlock = hasIdentity
      ? await buildIdentityBlock(identity.avatar, name, fontPx, outW - padX * 2)
      : null;
    const identityH = identityBlock ? identityBlock.height : 0;
    const identityTop = identityBlock ? padY : 0;
    const identityTextGap = identityBlock ? Math.max(12, Math.round(30 * scale)) : 0;

    const textTop = padY + identityH + identityTextGap;
    const rawBannerH = (lines.length || identityBlock)
      ? Math.ceil(padY + textTop + lines.length * lineHeight)
      : 0;
    // The total height must stay even for H.264/yuv420.
    const bannerH = isReel ? 0 : ((rawBannerH & ~1) || 2);
    let totalH = bannerH + outH;
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

    // Draw the banner once into a reusable offscreen bitmap.
    const banner = document.createElement('canvas');
    banner.width = outW * TEXT_SCALE; banner.height = (isReel ? reelLayerH : bannerH) * TEXT_SCALE;
    const bctx = banner.getContext('2d');
    bctx.scale(TEXT_SCALE, TEXT_SCALE);
    if (!isReel) {
      bctx.fillStyle = BANNER_BG;
      bctx.fillRect(0, 0, outW, bannerH);
    }
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
        bctx.strokeText(line, outW / 2, y, outW * 0.9);
        bctx.fillText(line, outW / 2, y, outW * 0.9);
      });
    } else {
      if (identityBlock) bctx.drawImage(identityBlock.canvas, padX, identityTop);
      bctx.textAlign = 'left';
      lines.forEach((line, i) => bctx.fillText(line, padX, textTop + i * lineHeight));
    }
    bctx.shadowColor = 'transparent';
    bctx.shadowBlur = 0;
    bctx.shadowOffsetY = 0;
    // The bitmap is only needed to build the pre-rendered circle.
    identityBlock?.bitmap.close?.();

    // Standard's media viewport keeps the source ratio. Only its card adds
    // space; the existing text geometry and output width stay unchanged.
    let card = null;
    if (!isReel) {
      try {
        const padding = Math.max(4, Math.round(outW * 0.018));
        const mediaW = outW - padding * 2;
        const mediaH = Math.max(2, Math.round(mediaW * srcH / srcW) & ~1);
        const radius = Math.min(mediaW / 2, mediaH / 2, Math.max(10, Math.round(outW * 0.025)));
        const gap = Math.max(6, Math.round(outW * 0.012));
        let signaturePx = Math.round(Math.max(9, Math.round(outW * 0.014)) * 1.5);
        const signature = 'Made with ClipTweet · cliptweet.github.io';
        measurer.font = `400 ${signaturePx}px ${BANNER_FONT_FAMILY}`;
        while (signaturePx > 7 && measurer.measureText(signature).width > mediaW) {
          signaturePx--;
          measurer.font = `400 ${signaturePx}px ${BANNER_FONT_FAMILY}`;
        }
        const footerH = branding ? gap + signaturePx * 1.35 : 0;
        const cardH = (Math.ceil(padding + mediaH + footerH + padding) + 1) & ~1;
        const decoration = document.createElement('canvas');
        decoration.width = outW * TEXT_SCALE;
        decoration.height = cardH * TEXT_SCALE;
        const ctx = decoration.getContext('2d');
        ctx.scale(TEXT_SCALE, TEXT_SCALE);
        ctx.fillStyle = STANDARD_SURFACE;
        ctx.fillRect(0, 0, outW, cardH);
        ctx.font = measurer.font;
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#b1bdc8';
        if (branding) ctx.fillText(signature, padding, padding + mediaH + gap);
        const mask = new Path2D();
        mask.roundRect(padding, bannerH + padding, mediaW, mediaH, radius);
        card = { decoration, mask, x: padding, y: bannerH + padding, width: mediaW, height: mediaH, cardH };
        totalH = bannerH + cardH;
      } catch (error) {
        // Card-only fallback: media fitting below still uses cover, never contain.
        console.warn('clip: Standard card unavailable; using the previous layout.', error);
      }
    }

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
    let output, conversion;
    for (const codec of codecOrder) {
      let encodable = false;
      try { encodable = await canEncodeVideo(codec, { width: outW, height: totalH }); }
      catch { encodable = false; }
      if (!encodable) continue;

      const candidateOutput = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
      const attempt = await Conversion.init({
        input, output: candidateOutput,
        video: {
          codec,
          forceTranscode: true,
          // No `width` option: process() already returns a frame at the final
          // output size, so any automatic resize stage would rescale the banner.
          quality: new Quality({ bitrate: Math.round(videoKbps * 1000) }),
          process: (sample) => {
            const viewport = card || { x: 0, y: isReel ? 0 : bannerH, width: outW, height: outH };
            if (card) fctx.drawImage(card.decoration, 0, bannerH, outW, card.cardH);
            fctx.save();
            try {
              if (card) fctx.clip(card.mask);
              else {
                fctx.beginPath();
                fctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
                fctx.clip();
              }
              // Uniform scale + centred excess: fills the viewport without
              // stretching, including rounding differences and rotated samples.
              const mediaAspect = sample.displayWidth / sample.displayHeight;
              const viewportAspect = viewport.width / viewport.height;
              if (Math.abs(mediaAspect - viewportAspect) < 1e-9) {
                sample.draw(fctx, viewport.x, viewport.y, viewport.width, viewport.height);
              } else {
                const cover = Math.max(viewport.width / sample.displayWidth, viewport.height / sample.displayHeight);
                const width = sample.displayWidth * cover, height = sample.displayHeight * cover;
                sample.draw(fctx, viewport.x + (viewport.width - width) / 2, viewport.y + (viewport.height - height) / 2, width, height);
              }
            } finally { fctx.restore(); }
            // Graphics are composited at final resolution after media fitting.
            if (!isReel && bannerH) fctx.drawImage(banner, 0, 0, outW, bannerH);
            if (isReel && lines.length) fctx.drawImage(banner, 0, reelTop, outW, reelLayerH);
            return frame;
          },
          processedWidth: outW,
          processedHeight: totalH,
        },
        // No audio options: the X source is already AAC, so Mediabunny copies
        // the track untouched. Forcing a transcode here silently dropped audio
        // on devices without an encoder for the source's channel/rate pairing.
      });

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

    conversion.onProgress = (p) => onProgress?.('Encoding your clip...', 0.15 + p * 0.8);
    await conversion.execute(signal ? { pauseSignal: signal } : undefined);

    const buffer = output.target.buffer;
    const blob = new Blob([buffer], { type: 'video/mp4' });

    // Safety net: never expose an oversized result.
    if (blob.size > MAX_BYTES) {
      throw new Error(`That video exceeds the ${MAX_BYTES / (1024 * 1024)} MB size limit. Try a shorter or lower-quality video.`);
    }
    return { blob, text: bannerText, lines, author: data.author, handle: data.handle };
  } finally {
    try { input.dispose(); } catch { /* already gone */ }
  }
}
