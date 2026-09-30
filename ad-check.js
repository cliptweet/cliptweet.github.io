// Check the real ad resource. No UA/fingerprint or attempts to bypass blockers.
(() => {
  const adUrl = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
  async function probe(url, mode = 'no-cors') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(url, { mode, cache: 'no-store', signal: controller.signal });
      return response.type === 'opaque' || response.ok ? 'available' : 'unknown';
    } catch (error) {
      return error.name === 'AbortError' || error.name === 'TimeoutError' ? 'unknown' : 'failed';
    } finally { clearTimeout(timer); }
  }
  let pending;
  let last = { at: 0, result: 'unknown' };
  window.checkAdAvailability = (force = false) => {
    if (pending) return pending;
    if (!force && Date.now() - last.at < 30000) return Promise.resolve(last.result);
    pending = (async () => {
      // An opaque successful fetch verifies delivery, unlike Brave's script shim.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await probe(adUrl);
        if (result !== 'failed') return result;
        if (navigator.onLine === false) return 'unknown';
        // Avoid blaming a blocker when the site or an independent CDN is offline.
        const controls = await Promise.all([
          probe('/robots.txt', 'same-origin'),
          probe('https://cdn.jsdelivr.net/npm/mediabunny@1.61.0/package.json'),
        ]);
        if (!controls.every(value => value === 'available')) return 'unknown';
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1500));
      }
      return 'blocked';
    })().catch(() => 'unknown').then(result => {
      last = { at: Date.now(), result };
      return result;
    }).finally(() => { pending = null; });
    return pending;
  };
})();
