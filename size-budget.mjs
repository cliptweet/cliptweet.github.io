export const MEBIBYTE = 1024 * 1024;
export const OUTPUT_SIZE_LIMITS = Object.freeze([
  20 * MEBIBYTE,
  100 * MEBIBYTE,
  512 * MEBIBYTE,
  4 * 1024 * MEBIBYTE,
]);
export const TARGET_RATIO = 0.995;
export const MAX_ENCODING_ATTEMPTS = 5;
export const MIN_VIDEO_BITRATE_BPS = 60_000;

const LEGACY_HEADROOM = 0.90;
const LEGACY_AUDIO_BITRATE_BPS = 128_000;
const CONTAINER_RESERVE_RATIO = 0.005;
const MIN_CONTAINER_RESERVE_BYTES = 64 * 1024;
const RETRY_SAFETY_RATIO = 0.97;
const MIN_RETRY_STEP_BPS = 1_000;

function requirePositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number.`);
}

export function targetBytesFor(maxBytes) {
  requirePositiveNumber(maxBytes, 'maxBytes');
  return Math.floor(maxBytes * TARGET_RATIO);
}

export function initialVideoBitrate({ maxBytes, durationSeconds, audioBitrateBps = LEGACY_AUDIO_BITRATE_BPS, maxVideoBitrateBps = 5_000_000 }) {
  requirePositiveNumber(maxBytes, 'maxBytes');
  requirePositiveNumber(durationSeconds, 'durationSeconds');
  requirePositiveNumber(maxVideoBitrateBps, 'maxVideoBitrateBps');
  if (!Number.isFinite(audioBitrateBps) || audioBitrateBps < 0) throw new TypeError('audioBitrateBps must be non-negative.');

  // Preserve the existing first-pass quality ceiling exactly. The measured-audio
  // budget may only make it safer; it can never raise the old bitrate.
  const legacyBitrate = Math.floor(Math.min(
    maxBytes * 8 * LEGACY_HEADROOM / durationSeconds / 1000 - LEGACY_AUDIO_BITRATE_BPS / 1000,
    maxVideoBitrateBps / 1000,
  )) * 1000;
  const targetBytes = targetBytesFor(maxBytes);
  const containerReserveBytes = Math.max(MIN_CONTAINER_RESERVE_BYTES, Math.floor(maxBytes * CONTAINER_RESERVE_RATIO));
  const measuredBudget = Math.floor((targetBytes - containerReserveBytes) * 8 / durationSeconds - audioBitrateBps);

  return Math.min(legacyBitrate, measuredBudget, maxVideoBitrateBps);
}

export function nextVideoBitrate({ currentBitrateBps, actualBytes, targetBytes, minBitrateBps = MIN_VIDEO_BITRATE_BPS }) {
  requirePositiveNumber(currentBitrateBps, 'currentBitrateBps');
  requirePositiveNumber(actualBytes, 'actualBytes');
  requirePositiveNumber(targetBytes, 'targetBytes');
  requirePositiveNumber(minBitrateBps, 'minBitrateBps');
  if (currentBitrateBps <= minBitrateBps) return null;

  const observedCorrection = Math.floor(currentBitrateBps * targetBytes / actualBytes * RETRY_SAFETY_RATIO);
  return Math.max(minBitrateBps, Math.min(currentBitrateBps - MIN_RETRY_STEP_BPS, observedCorrection));
}

export function assertOutputWithinLimit(blob, maxBytes) {
  requirePositiveNumber(maxBytes, 'maxBytes');
  if (!blob || !Number.isFinite(blob.size) || blob.size <= 0) throw new Error('Generation did not produce a valid output file.');
  if (blob.size > maxBytes) {
    const error = new Error('Could not generate a clip within the selected file-size limit. Try a larger limit.');
    error.code = 'OUTPUT_SIZE_LIMIT';
    throw error;
  }
  return blob;
}

export function exposeOutput(blob, maxBytes, expose) {
  assertOutputWithinLimit(blob, maxBytes);
  return expose(blob);
}

export async function exposeOutputAfterFrame({ blob, maxBytes, signal, nextFrame, expose }) {
  throwIfAborted(signal);
  assertOutputWithinLimit(blob, maxBytes);
  await nextFrame();
  throwIfAborted(signal);
  return exposeOutput(blob, maxBytes, expose);
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = typeof DOMException === 'function'
    ? new DOMException('Generation canceled.', 'AbortError')
    : Object.assign(new Error('Generation canceled.'), { name: 'AbortError' });
  throw error;
}

export async function executeWithCancellation(conversion, signal) {
  throwIfAborted(signal);
  let cancelRequested = false;
  let cancelPromise;
  const cancel = () => {
    if (cancelRequested) return cancelPromise;
    cancelRequested = true;
    cancelPromise = Promise.resolve(conversion.cancel()).catch(() => {});
    return cancelPromise;
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    await conversion.execute();
    throwIfAborted(signal);
  } catch (error) {
    await cancel();
    if (signal?.aborted) throwIfAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export async function encodeWithinSizeLimit({ maxBytes, initialBitrateBps, encodeAttempt, signal, onAttempt, maxAttempts = MAX_ENCODING_ATTEMPTS, minBitrateBps = MIN_VIDEO_BITRATE_BPS }) {
  requirePositiveNumber(maxBytes, 'maxBytes');
  requirePositiveNumber(initialBitrateBps, 'initialBitrateBps');
  requirePositiveNumber(maxAttempts, 'maxAttempts');
  requirePositiveNumber(minBitrateBps, 'minBitrateBps');
  if (initialBitrateBps < minBitrateBps) throw new Error('Initial video bitrate is below the supported minimum.');
  const targetBytes = targetBytesFor(maxBytes);
  let bitrateBps = initialBitrateBps;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const blob = await encodeAttempt({ attempt, bitrateBps, targetBytes, signal });
    throwIfAborted(signal);
    if (!blob || !Number.isFinite(blob.size) || blob.size <= 0) throw new Error('Generation did not produce a valid output file.');
    onAttempt?.({ attempt, bitrateBps, targetBytes, outputBytes: blob.size, withinLimit: blob.size <= maxBytes });
    if (blob.size <= maxBytes) return { blob, attempt, bitrateBps, targetBytes };

    if (attempt === maxAttempts) break;
    const next = nextVideoBitrate({ currentBitrateBps: bitrateBps, actualBytes: blob.size, targetBytes, minBitrateBps });
    if (next === null) break;
    bitrateBps = next;
  }

  const error = new Error('Could not generate a clip within the selected file-size limit. Try a larger limit.');
  error.code = 'OUTPUT_SIZE_LIMIT';
  throw error;
}
