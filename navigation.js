(() => {
  const email = 'cliptweetotizera@gmail.com';
  const dialog = document.getElementById('contactDialog');
  const copyButton = document.getElementById('copyEmail');
  const copyStatus = document.getElementById('copyStatus');
  let contactTrigger;
  let copyTimer;
  let scrollFrame = null;
  let highlightTimer;
  let highlightedSection;

  function clearHighlight() {
    clearTimeout(highlightTimer);
    highlightedSection?.classList.remove('navigation-arrival');
    highlightedSection = null;
  }

  function cancelScroll() {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
  }

  function arrive(heading) {
    heading.focus({ preventScroll: true });
    const section = heading.closest('.navigation-copy');
    // Flush removal so another click restarts the CSS animation, even at the destination.
    void section.offsetWidth;
    section.classList.add('navigation-arrival');
    highlightedSection = section;
    highlightTimer = setTimeout(clearHighlight, 2000);
  }

  function navigate(hash) {
    cancelScroll();
    clearHighlight();
    const heading = ['#about', '#how-it-works'].includes(hash)
      ? document.getElementById(hash.slice(1)) : null;
    if (!heading) return;
    heading.tabIndex = -1;
    const start = scrollY;
    const header = document.querySelector('.site-header');
    const fixedHeader = ['fixed', 'sticky'].includes(getComputedStyle(header).position) ? header.getBoundingClientRect().bottom : 0;
    const margin = Math.max(parseFloat(getComputedStyle(heading).scrollMarginTop), fixedHeader + 24);
    const target = Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight,
      start + heading.getBoundingClientRect().top - margin));
    const distance = target - start;
    if (Math.abs(distance) < 1) {
      scrollTo({ top: target, behavior: 'instant' });
      arrive(heading);
      return;
    }
    const duration = Math.min(1000, 550 + Math.abs(distance) * 0.3);
    const started = performance.now();
    function step(now) {
      const progress = Math.min(1, (now - started) / duration);
      const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
      scrollTo({ top: start + distance * eased, behavior: 'instant' });
      if (progress < 1) scrollFrame = requestAnimationFrame(step);
      else {
        scrollFrame = null;
        arrive(heading);
      }
    }
    scrollFrame = requestAnimationFrame(step);
  }

  addEventListener('hashchange', () => navigate(location.hash));
  addEventListener('wheel', cancelScroll, { passive: true });
  addEventListener('touchstart', cancelScroll, { passive: true });
  addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelScroll();
  });
  document.querySelectorAll('a[href="#about"], a[href="#how-it-works"], a[href="#contact"]').forEach(link => {
    if (link.hash === '#contact') {
      link.setAttribute('aria-haspopup', 'dialog');
      link.setAttribute('aria-controls', 'contactDialog');
    }
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.hash === '#contact') {
        event.preventDefault();
        cancelScroll();
        contactTrigger = link;
        dialog.showModal();
      } else {
        event.preventDefault();
        if (location.hash !== link.hash) history.pushState(null, '', link.hash);
        navigate(link.hash);
      }
    });
  });
  if (location.hash) navigate(location.hash);

  document.getElementById('closeContact').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    clearTimeout(copyTimer);
    copyButton.textContent = 'Copy email';
    copyStatus.textContent = '';
    contactTrigger?.focus({ preventScroll: true });
  });
  copyButton.addEventListener('click', async () => {
    clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(email);
      if (!dialog.open) return;
      copyButton.textContent = 'Copied!';
      copyStatus.textContent = 'Email address copied.';
    } catch {
      if (!dialog.open) return;
      copyStatus.textContent = 'Could not copy automatically. Select the email address to copy it manually.';
    }
    copyTimer = setTimeout(() => {
      copyButton.textContent = 'Copy email';
      copyStatus.textContent = '';
    }, 2200);
  });
})();
