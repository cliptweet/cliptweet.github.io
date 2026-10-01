const generateBtn = document.getElementById('generateBtn');
const input = document.getElementById('tweetUrl');
const statusDiv = document.getElementById('status');
const previewContainer = document.getElementById('previewContainer');
const previewVideo = document.getElementById('previewVideo');
const downloadBtn = document.getElementById('downloadBtn');
const adNotice = document.getElementById('adNotice');
const adNoticeClose = document.getElementById('adNoticeClose');
const profileUrlInput = document.getElementById('profileUrl');
const displayNameInput = document.getElementById('displayName');
const profileStatus = document.getElementById('profileStatus');
const profilePreview = document.getElementById('profilePreview');
const profileAvatar = document.getElementById('profileAvatar');
const profilePreviewName = document.getElementById('profilePreviewName');
const personalizeBox = document.getElementById('personalizeBox');
const brandingOptions = document.getElementById('brandingOptions');
const withoutBranding = document.getElementById('withoutBranding');
const sizeInputs = Array.from(document.querySelectorAll('input[name="maxFileSize"]'));
const sizeDescription = document.getElementById('sizeDescription');
const sizeWarning = document.getElementById('sizeWarning');
const layoutInputs = Array.from(document.querySelectorAll('input[name="version"]'));
let generating = false;
let objectUrl;

// Advertising never controls generation or downloads.
if (matchMedia('(min-width: 1201px)').matches) {
  document.querySelectorAll('.ad-slot .adsbygoogle').forEach(() => {
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); }
    catch (error) { console.warn('AdSense slot could not initialize.', error); }
  });
}

// ── Optional identity (avatar + display name) ─────────────────────────────────
// Resolution is best-effort and never blocks Generate: if it fails or is still
// running at generate time, the clip is produced without the identity block.
const profileCache = new Map();
let profileController = null;
let debounceId = 0;

const PROFILE_WAIT_MS = 8000;

function setProfileStatus(message, tone = '') {
  profileStatus.textContent = message;
  if (tone) profileStatus.dataset.tone = tone;
  else delete profileStatus.dataset.tone;
}

let resolvedHandle = '';
function showProfilePreview(handle, avatarSrc) {
  resolvedHandle = handle;
  profileAvatar.src = avatarSrc;
  profileAvatar.alt = `Profile picture of @${handle}`;
  const typed = displayNameInput.value.trim();
  profilePreviewName.textContent = typed || `@${handle}`;
  profilePreview.hidden = false;
}

function hideProfilePreview() {
  resolvedHandle = '';
  profilePreview.hidden = true;
  profileAvatar.removeAttribute('src');
}

// A post link is the only accepted input; the display name is never sent.
// Returns the author handle plus the status id, which the resolver accepts in
// its canonical /i/status/<id> form.
function parseProfileInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const postMatch = value.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:([A-Za-z0-9_]{1,15})\/status|i\/(?:web\/)?status)\/(\d{5,25})\/?$/i);
  if (postMatch) return { kind: 'post', handle: postMatch[1] || '', statusId: postMatch[2] };
  const profileMatch = value.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})\/?$/i) || value.match(/^@?([A-Za-z0-9_]{1,15})$/);
  if (profileMatch) return { kind: 'profile', handle: profileMatch[1] };
  return null;
}

function clearProfile() {
  profileController?.abort();
  profileController = null;
  hideProfilePreview();
  setProfileStatus('');
  profileUrlInput.setAttribute('aria-invalid', 'false');
}

async function resolveProfile(raw) {
  const parsed = parseProfileInput(raw);
  if (!parsed) return { error: 'Invalid profile' };
  if (profileCache.has(parsed.handle)) return { ...profileCache.get(parsed.handle), handle: parsed.handle };

  // Only the newest request may write state.
  profileController?.abort();
  const controller = new AbortController();
  profileController = controller;
  setProfileStatus('Loading profile…');
  const apiBase = String(globalThis.CLIPTWEET_API_BASE || '').replace(/\/$/, '');
  try {
    const profileFetchUrl = parsed.kind === 'post' ? `${apiBase}/api/profile` : `${apiBase}/api/profile?url=${encodeURIComponent(raw)}`;
    const profileFetchOptions = parsed.kind === 'post' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `https://x.com/i/status/${parsed.statusId}` }), signal: controller.signal } : { method: 'GET', signal: controller.signal };
    let res;
    try {
      res = await fetch(profileFetchUrl, profileFetchOptions);
    } catch (err) {
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (controller.signal.aborted) return { empty: true };
    if (!res.ok) return { error: data.error || 'Could not load the profile.' };
    const entry = { handle: data.handle || data.username || parsed.handle, avatar: data.avatar || null };
    profileCache.set(parsed.handle, entry);
    return entry;
  } catch (error) {
    if (error.name === 'AbortError') return { empty: true };
    return { error: "Couldn't load the profile. You can still generate without it." };
  }
}

function scheduleProfileResolve() {
  clearTimeout(debounceId);
  debounceId = setTimeout(() => { runProfileResolve(); }, 600);
}

async function runProfileResolve() {
  const result = await resolveProfile(profileUrlInput.value);
  if (result.empty) { clearProfile(); return result; }
  if (result.error) {
    hideProfilePreview();
    setProfileStatus(result.error === 'Invalid profile' ? 'Invalid profile' : result.error, 'error');
    profileUrlInput.setAttribute('aria-invalid', 'true');
    return result;
  }
  profileUrlInput.setAttribute('aria-invalid', 'false');
  if (!result.avatar) {
    hideProfilePreview();
    setProfileStatus('This account has no profile picture', 'error');
    return result;
  }
  if (!displayNameInput.value.trim()) {
    setProfileStatus('Add a display name to show your profile', 'ok');
  } else {
    setProfileStatus('', 'ok');
  }
  showProfilePreview(result.handle, result.avatar);
  return result;
}

profileUrlInput.addEventListener('input', () => {
  profileUrlInput.setAttribute('aria-invalid', 'false');
  scheduleProfileResolve();
});
profileUrlInput.addEventListener('blur', () => { clearTimeout(debounceId); runProfileResolve(); });
profileUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounceId); runProfileResolve(); } });
displayNameInput.addEventListener('input', () => {
  if (profilePreview.hidden) return;
  const typed = displayNameInput.value.trim();
  profilePreviewName.textContent = typed || `@${resolvedHandle}`;
  if (resolvedHandle && !profileAvatar.getAttribute('src')) return;
  setProfileStatus(typed ? '' : 'Add a display name to show your profile', 'ok');
});

try { if (sessionStorage.getItem('cliptweet-ad-notice-dismissed') === '1') adNotice.hidden = true; } catch {}
adNoticeClose.addEventListener('click', () => {
  adNotice.hidden = true;
  try { sessionStorage.setItem('cliptweet-ad-notice-dismissed', '1'); } catch {}
});

function setBusy(value) {
  generating = value;
  generateBtn.disabled = value;
  input.disabled = value;
  layoutInputs.forEach(radio => { radio.disabled = value; });
  sizeInputs.forEach(radio => { radio.disabled = value; });
  withoutBranding.disabled = value;
}

function updateLayout() {
  const isReel = layoutInputs.find(radio => radio.checked)?.value === 'reel';
  personalizeBox.hidden = isReel;
  brandingOptions.hidden = isReel;
  if (isReel) clearProfile();
}
layoutInputs.forEach(radio => radio.addEventListener('change', updateLayout));
sizeInputs.forEach(radio => radio.addEventListener('change', () => { sizeDescription.textContent = radio.dataset.description; }));
updateLayout();

generateBtn.addEventListener('click', async () => {
  if (generating) return;
  const url = input.value.trim();
  if (!url) { statusDiv.textContent = 'Paste a valid X/Twitter post URL.'; return; }
  setBusy(true);
  previewContainer.classList.remove('active');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600_000);
  let identity = null;
  try {
    // A resolve still in flight gets a short grace period; after that the clip
    // is generated without the identity block rather than being blocked.
    const typedName = displayNameInput.value.trim();
    const version = layoutInputs.find(radio => radio.checked)?.value || 'standard';
    if (version === 'standard' && profileUrlInput.value.trim() && typedName) {
      const settled = await Promise.race([
        runProfileResolve(),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), PROFILE_WAIT_MS)),
      ]);
      if (!settled?.timeout && settled?.handle && settled.avatar) {
        identity = { avatar: settled.avatar, name: typedName };
      } else {
        const why = settled?.timeout
          ? 'Profile lookup timed out. Generating without it.'
          : (profileStatus.textContent || 'Profile unavailable. Generating without it.');
        setProfileStatus(why, 'error');
      }
    }
    const { generateClip, normalizeTweetUrl } = await import('./clip.js');
    try { normalizeTweetUrl(url); } catch (error) { statusDiv.textContent = error.message; return; }
    const maxBytes = Number(sizeInputs.find(radio => radio.checked)?.value || 20971520);
    sizeWarning.hidden = true;
    sizeWarning.textContent = '';
    sizeWarning.dataset.level = '';
    const result = await generateClip({ url, version, branding: !withoutBranding.checked, identity: version === 'standard' ? identity : null, maxBytes, signal: controller.signal, onProgress: message => { statusDiv.textContent = message; }, onWarning: notice => { sizeWarning.textContent = [notice.message, notice.recommendation].filter(Boolean).join(' '); sizeWarning.dataset.level = notice.level; sizeWarning.hidden = false; } });
    statusDiv.textContent = 'Encoding your clip... 100%';
    await new Promise(requestAnimationFrame);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(result.blob);
    previewVideo.src = objectUrl;
    previewContainer.classList.add('active');
    statusDiv.textContent = 'Ready to download.';
    downloadBtn.onclick = () => {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'clip.mp4';
      document.body.appendChild(link);
      link.click();
      link.remove();
    };
  } catch (error) {
    statusDiv.textContent = error.name === 'AbortError' ? 'Generation timed out.' : error.message || 'Could not generate the clip.';
  } finally {
    clearTimeout(timeoutId);
    setBusy(false);
  }
});

window.addEventListener('beforeunload', () => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
