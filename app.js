const generateBtn = document.getElementById('generateBtn');
const input = document.getElementById('tweetUrl');
const statusDiv = document.getElementById('status');
const previewContainer = document.getElementById('previewContainer');
const previewVideo = document.getElementById('previewVideo');
const downloadBtn = document.getElementById('downloadBtn');
let generating = false;
let objectUrl;

function setBusy(value) {
  generating = value;
  generateBtn.disabled = value;
  input.disabled = value;
}

generateBtn.addEventListener('click', async () => {
  if (generating) return;
  const url = input.value.trim();
  if (!url) { statusDiv.textContent = 'Paste a valid X/Twitter post URL.'; return; }
  setBusy(true);
  previewContainer.classList.remove('active');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600_000);
  try {
    const { generateClip, normalizeTweetUrl } = await import('./clip.js');
    try { normalizeTweetUrl(url); } catch (error) { statusDiv.textContent = error.message; return; }
    const result = await generateClip({ url, signal: controller.signal, onProgress: message => { statusDiv.textContent = message; } });
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
