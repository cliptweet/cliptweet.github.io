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
// floor to sharpen the text does not shrink it. High is unchanged from the
// original 1280px-wide reference. Low reproduces the 320px-era proportions,
// where the 18px minimum used to inflate the font to 18/320 = 5.6% of width.
const BANNER_SPEC = {
  low:  { refW: 640,  fontPx: 36, lineHeight: 38, padY: 24 },
  high: { refW: 1280, fontPx: 58, lineHeight: 76, padY: 46 },
};
const MIN_FONT_PX = 18;

// `minWidth` is the composition floor: a frame narrower than the display size
// gets upscaled by the browser, and the upscaled banner text is what looked
// 8-bit. High has no floor, so its output is unchanged.
const PROFILES = {
  low:  { width: 640,  minWidth: 640,  maxVideoKbps: 900,  audioKbps: 64  },
  high: { width: 1280, minWidth: 0,    maxVideoKbps: 5000, audioKbps: 128 },
};

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

// ── Main pipeline ────────────────────────────────────────────────────────────

export async function generateClip({ url, quality, onProgress, signal }) {
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
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not read that post.');
  if (statusId && data.id && data.id !== statusId) {
    throw new Error('That link no longer matches the post. Copy the link again.');
  }

  const profile = PROFILES[quality] || PROFILES.low;
  const durationSec = (data.durationMs || 0) / 1000;
  if (durationSec > MAX_DURATION_SEC) {
    throw new Error('That video is longer than 10 minutes.');
  }
  if (!durationSec) throw new Error('Could not determine the video duration.');

  // Low deliberately uses the smallest variant: less bandwidth, less decode work.
  const variant = quality === 'high' ? data.variants.at(-1) : data.variants[0];
  if (!variant) throw new Error('That post has no playable video.');

  // Duration-aware bitrate budget with headroom, so the result cannot exceed
  // 20 MB. The per-tier cap is what keeps Low materially cheaper and lower
  // quality than High on short clips; the budget only binds on long ones.
  const totalKbps = (MAX_BYTES * 8 * HEADROOM) / durationSec / 1000;
  const audioKbps = profile.audioKbps;
  const videoKbps = Math.floor(Math.min(totalKbps - audioKbps, profile.maxVideoKbps));
  if (videoKbps < 60) {
    throw new Error('That video is too long to fit in the 20 MB limit at a usable quality.');
  }

  onProgress?.('Downloading the video...', 0.06);

  // X's CDN answers 403 to any request that carries a Referer header, so the
  // media fetch must not send one. This is a hotlink-protection rule, not a
  // CORS rule — CORS itself is open and the request is cross-origin either way.
  const source = new UrlSource(variant.url, { requestInit: { referrerPolicy: 'no-referrer' } });
  const input = new Input({ formats: ALL_FORMATS, source });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('That post has no video track.');

    const srcW = await videoTrack.getDisplayWidth();
    const srcH = await videoTrack.getDisplayHeight();
    // Even width/height keeps H.264 encoders happy.
    const outW = Math.max(profile.minWidth, Math.min(profile.width, srcW)) & ~1;
    const outH = Math.max(2, Math.round(outW * (srcH / srcW)) & ~1);

    // Banner metrics scale with the frame, so the text keeps the same share of
    // the width and the same on-screen size as the 320px-era original.
    const spec = BANNER_SPEC[quality] || BANNER_SPEC.low;
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
    const lines = bannerText ? layoutLines(measurer, bannerText, outW - padX * 2) : [];
    // A post that is nothing but a link yields no prose, so no banner at all
    // rather than an empty black bar.
    const bannerH = lines.length ? Math.ceil(padY * 2 + lines.length * lineHeight) : 0;
    const totalH = bannerH + outH;

    // Draw the banner once into a reusable offscreen bitmap.
    const banner = document.createElement('canvas');
    banner.width = outW; banner.height = bannerH;
    const bctx = banner.getContext('2d');
    bctx.fillStyle = BANNER_BG; bctx.fillRect(0, 0, outW, bannerH);
    bctx.fillStyle = BANNER_FG;
    bctx.font = font;
    bctx.textAlign = 'center'; bctx.textBaseline = 'top';
    // A tight shadow firms up the glyph edges once the frame is scaled down for
    // display, without changing the flat two-tone look.
    bctx.shadowColor = 'rgba(0,0,0,0.45)';
    bctx.shadowBlur = Math.max(1, fontPx / 10);
    bctx.shadowOffsetY = Math.max(1, Math.round(fontPx / 24));
    lines.forEach((line, i) => bctx.fillText(line, outW / 2, padY + i * lineHeight));
    bctx.shadowColor = 'transparent';
    bctx.shadowBlur = 0;
    bctx.shadowOffsetY = 0;

    const frame = document.createElement('canvas');
    frame.width = outW; frame.height = totalH;
    const fctx = frame.getContext('2d', { alpha: false });

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
            fctx.drawImage(banner, 0, 0);
            // Explicit size: the video is scaled to the final frame, so the
            // banner above is never resampled and the text stays crisp.
            sample.draw(fctx, 0, bannerH, outW, outH);
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
      throw new Error('That video is too long to fit in the 20 MB limit. Try a shorter post.');
    }
    return { blob, text: bannerText, lines, author: data.author, handle: data.handle };
  } finally {
    try { input.dispose(); } catch { /* already gone */ }
  }
}
