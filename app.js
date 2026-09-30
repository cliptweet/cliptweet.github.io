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
let generating = false;
let objectUrl;
const layoutInputs = Array.from(document.querySelectorAll('input[name="version"]'));

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
let profilePending = null;   // { handle, promise }
let profileController = null;
let debounceId = 0;
function syncLayout() {
  const standard = layoutInputs.find(radio => radio.checked)?.value !== 'reel';
  personalizeBox.hidden = !standard;
}
layoutInputs.forEach(radio => radio.addEventListener('change', syncLayout));
syncLayout();

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
function extractProfilePost(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let u;
  try { u = new URL(withScheme); } catch { throw new Error('Invalid profile'); }
  if (u.protocol !== 'https:') throw new Error('Invalid profile');
  if (!/^(www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname)) throw new Error('Invalid profile');
  const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})\/?$/);
  if (!m) throw new Error('Invalid profile');
  return { handle: m[1], statusId: m[2] };
}

function clearProfile() {
  profileController?.abort();
  profileController = null;
  profilePending = null;
  hideProfilePreview();
  setProfileStatus('');
  profileUrlInput.setAttribute('aria-invalid', 'false');
}

async function resolveProfile(raw) {
  let post;
  try { post = extractProfilePost(raw); }
  catch { return { error: 'Invalid profile' }; }
  if (!post) return { empty: true };
  if (profileCache.has(post.handle)) return { ...profileCache.get(post.handle), handle: post.handle };

  // Only the newest request may write state.
  profileController?.abort();
  const controller = new AbortController();
  profileController = controller;
  setProfileStatus('Loading profile…');
  const apiBase = String(globalThis.CLIPTWEET_API_BASE || '').replace(/\/$/, '');
  try {
    const res = await fetch(`${apiBase}/api/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `https://x.com/i/status/${post.statusId}` }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (controller.signal.aborted) return { empty: true };
    if (!res.ok) return { error: data.error || 'Could not load the profile.' };
    const entry = { handle: data.handle || post.handle, avatar: data.avatar || null };
    profileCache.set(post.handle, entry);
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
    profilePending = null;
    return result;
  }
  profileUrlInput.setAttribute('aria-invalid', 'false');
  if (!result.avatar) {
    hideProfilePreview();
    setProfileStatus('This account has no profile picture', 'error');
    profilePending = null;
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
}

generateBtn.addEventListener('click', async () => {
  if (generating) return;
  const sourcePostUrl = input.value.trim();
  if (!sourcePostUrl) { statusDiv.textContent = 'Paste a valid X/Twitter post URL.'; return; }
  setBusy(true);
  previewContainer.classList.remove('active');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600_000);
  let identity = null;
  try {
    // A resolve still in flight gets a short grace period; after that the clip
    // is generated without the identity block rather than being blocked.
    const typedName = displayNameInput.value.trim();
    const standard = layoutInputs.find(radio => radio.checked)?.value !== 'reel';
    if (standard && profileUrlInput.value.trim() && typedName) {
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
    try { normalizeTweetUrl(sourcePostUrl); } catch (error) { statusDiv.textContent = error.message; return; }
    const version = layoutInputs.find(radio => radio.checked)?.value || 'standard';
    const result = await generateClip({ url: sourcePostUrl, version, identity: standard ? identity : null, signal: controller.signal, onProgress: message => { statusDiv.textContent = message; } });
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(result.blob);
    previewVideo.src = objectUrl;
    previewContainer.classList.add('active');
    statusDiv.textContent = 'Clip generated successfully.';
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
