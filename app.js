const POLICY_KEY = 'policyAccepted';
const policyOverlay = document.getElementById('policyOverlay');
const policyAccept = document.getElementById('policyAccept');
const generateBtn = document.getElementById('generateBtn');
const qualityInputs = document.querySelectorAll('input[name="quality"]');
const appContent = document.getElementById('appContent');
const adblockWall = document.getElementById('adblockWall');
const adblockReload = document.getElementById('adblockReload');
let adBlockDetected = false;
let generating = false;
let checkingAds = false;

function updateControls() {
  generateBtn.disabled = adBlockDetected || generating || checkingAds;
  qualityInputs.forEach(input => { input.disabled = adBlockDetected || generating; });
}

function showAdblockWall() {
  adBlockDetected = true;
  appContent.inert = true;
  adblockWall.hidden = false;
  document.body.style.overflow = 'hidden';
  updateControls();
  adblockReload.focus();
}

adblockReload.addEventListener('click', async () => {
  adBlockDetected = false;
  adblockReload.disabled = true;
  checkingAds = true;
  updateControls();
  try {
    if ((await window.checkAdAvailability(true)) === 'blocked') showAdblockWall();
  } finally {
    checkingAds = false;
    updateControls();
  }
  if (!adBlockDetected) {
    adblockWall.hidden = true;
    appContent.inert = false;
    document.body.style.overflow = '';
  }
  adblockReload.disabled = false;
});
document.addEventListener('focusin', event => {
  if (adBlockDetected && !adblockWall.contains(event.target)) adblockReload.focus();
});
adblockWall.addEventListener('keydown', event => {
  if (event.key === 'Tab' || event.key === 'Escape') {
    event.preventDefault();
    adblockReload.focus();
  }
});
new MutationObserver(() => {
  if (adBlockDetected && !adblockWall.isConnected) {
    document.body.appendChild(adblockWall);
    adblockReload.focus();
  }
}).observe(document.body, { childList: true, subtree: true });

async function detectAdBlock() {
  if (adBlockDetected) return true;
  checkingAds = true;
  updateControls();
  try {
    const result = await window.checkAdAvailability();
    if (result === 'blocked') showAdblockWall();
    return result === 'blocked';
  } finally {
    checkingAds = false;
    updateControls();
  }
}

function openPolicy() {
  policyOverlay.classList.add('active');
}

function closePolicy() {
  policyOverlay.classList.remove('active');
}

policyAccept.addEventListener('click', () => {
  try { localStorage.setItem(POLICY_KEY, 'true'); } catch { /* private storage unavailable */ }
  closePolicy();
});

// First-visit policy gate
try { if (!localStorage.getItem(POLICY_KEY)) openPolicy(); }
catch { openPolicy(); }

let selectedQuality = 'low';
const adWarning = document.getElementById('adWarning');
const highQualityLabel = document.querySelector('label[for="q-high"]');

function isPreviewVisible() {
  return document.getElementById('previewContainer').classList.contains('active');
}

function updateAdWarning() {
  const show = selectedQuality === 'high' && !isPreviewVisible();
  adWarning.style.display = show ? 'block' : 'none';
  highQualityLabel.textContent = show ? '📺 High quality' : 'High quality';
}

document.querySelectorAll('input[name="quality"]').forEach(radio => {
  radio.addEventListener('change', () => { selectedQuality = radio.value; updateAdWarning(); });
});
updateAdWarning();

// Check only on generation: informational content stays crawlable and usable.

generateBtn.addEventListener('click', async () => {
  if (adBlockDetected || generating || checkingAds) return;
  const url = document.getElementById('tweetUrl').value.trim();
  const statusDiv = document.getElementById('status');
  const previewContainer = document.getElementById('previewContainer');
  const previewVideo = document.getElementById('previewVideo');
  const downloadBtn = document.getElementById('downloadBtn');
  const downloadSection = previewContainer.querySelector('.download-section');
  const adOverlay = document.getElementById('adPlaceholderOverlay');

  if (!url) { statusDiv.textContent = 'Enter a valid URL.'; return; }
  generating = true;
  updateControls();
  let timeoutId;
  let controller = null;
  try {
    if (await detectAdBlock()) return;
    previewContainer.classList.remove('active');
    downloadSection.classList.remove('active');
    updateAdWarning();

    controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 600_000);
    const { generateClip, normalizeTweetUrl } = await import('./clip.js');

    // Normalise first so bad links fail fast with a specific message.
    try { normalizeTweetUrl(url); }
    catch (err) { statusDiv.textContent = err.message; return; }

    const result = await generateClip({
      url,
      quality: selectedQuality,
      signal: controller.signal,
      onProgress: (message) => { statusDiv.textContent = message; },
    });

    const objectUrl = URL.createObjectURL(result.blob);
    statusDiv.textContent = 'Clip generated successfully!';

    const showResult = () => {
      previewVideo.src = objectUrl;
      previewContainer.classList.add('active');
      downloadSection.classList.add('active');
      updateAdWarning();
      downloadBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = 'clip.mp4';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      };
    };

    if (selectedQuality === 'high') {
      // Re-check the ad blocker before revealing the gate, so the overlay
      // is never visible in a state where its click handler is not armed.
      if (await detectAdBlock()) {
        statusDiv.textContent = 'Ad blocker detected.';
        return;
      }
      statusDiv.textContent = 'Clip generated. Watch the ad to unlock preview and download.';
      adOverlay.onclick = () => { adOverlay.classList.remove('active'); showResult(); };
      document.querySelector('.ad-placeholder-close').onclick = (e) => {
        e.stopPropagation(); adOverlay.classList.remove('active'); showResult();
      };
      adOverlay.classList.add('active');
    } else {
      showResult();
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      statusDiv.textContent = 'Encoding was cancelled.';
    } else {
      statusDiv.textContent = err.message || 'Could not generate the clip. Please try again.';
    }
  } finally {
    clearTimeout(timeoutId);
    generating = false;
    updateControls();
  }
});

detectAdBlock();
