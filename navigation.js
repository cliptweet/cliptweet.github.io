(() => {
  const email = 'kendestrozado@gmail.com';
  const dialog = document.getElementById('contactDialog');
  const copyButton = document.getElementById('copyEmail');
  const copyStatus = document.getElementById('copyStatus');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let contactTrigger;
  let copyTimer;
  let scrollFrame = null;
  let highlightTimer;
  let highlightedSection;
  let highlights = [];

  function clearHighlight() {
    clearTimeout(highlightTimer);
    highlights.forEach(animation => animation.cancel());
    highlights = [];
    highlightedSection?.classList.remove('navigation-arrival');
    highlightedSection = null;
  }

  function cancelScroll() {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
  }

  function arrive(heading) {
    heading.focus({ preventScroll: true });
    if (reducedMotion.matches) return;
    const section = heading.closest('section');
    section.classList.add('navigation-arrival');
    highlightedSection = section;
    highlights = [...section.querySelectorAll(':scope > h2, :scope > p, :scope > ol')].map(content => content.animate([
      { filter: 'brightness(1)', textShadow: '0 0 10px rgb(96 185 255 / 0%)' },
      { filter: 'brightness(1.12)', textShadow: '0 0 10px rgb(96 185 255 / 20%)', offset: 0.35 },
      { filter: 'brightness(1)', textShadow: '0 0 10px rgb(96 185 255 / 0%)' }
    ], { duration: 2000, easing: 'ease-in-out' }));
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
    const target = Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight,
      start + heading.getBoundingClientRect().top - parseFloat(getComputedStyle(heading).scrollMarginTop)));
    const distance = target - start;
    if (reducedMotion.matches || Math.abs(distance) < 1) {
      scrollTo({ top: target, behavior: 'instant' });
      arrive(heading);
      return;
    }
    const duration = Math.min(1100, 500 + Math.abs(distance) * 0.25);
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
  reducedMotion.addEventListener('change', () => {
    if (scrollFrame !== null) navigate(location.hash);
    else clearHighlight();
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
