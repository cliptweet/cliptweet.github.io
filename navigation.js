(() => {
  const email = 'kendestrozado@gmail.com';
  const dialog = document.getElementById('contactDialog');
  const copyButton = document.getElementById('copyEmail');
  const copyStatus = document.getElementById('copyStatus');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let contactTrigger;
  let copyTimer;
  let arrivalTimer;
  let highlightTimer;
  let pendingHeading;
  let highlightedSection;

  function arrive() {
    clearTimeout(arrivalTimer);
    const heading = pendingHeading;
    pendingHeading = null;
    if (!heading) return;
    const bounds = heading.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > innerHeight) return;
    heading.focus({ preventScroll: true });
    if (reducedMotion.matches) return;
    const section = heading.closest('section');
    section.classList.add('navigation-arrival');
    highlightedSection = section;
    highlightTimer = setTimeout(() => {
      section.classList.remove('navigation-arrival');
      if (highlightedSection === section) highlightedSection = null;
    }, 1600);
  }

  function markDestination(hash) {
    clearTimeout(arrivalTimer);
    clearTimeout(highlightTimer);
    highlightedSection?.classList.remove('navigation-arrival');
    highlightedSection = null;
    pendingHeading = ['#about', '#how-it-works'].includes(hash)
      ? document.getElementById(hash.slice(1)) : null;
    if (!pendingHeading) return;
    pendingHeading.tabIndex = -1;
    // Native fragments own scrolling and history. scrollend marks arrival;
    // this timeout also covers no-scroll clicks and older browsers.
    arrivalTimer = setTimeout(arrive, reducedMotion.matches ? 0 : 1200);
  }

  document.addEventListener('scrollend', arrive);
  addEventListener('hashchange', () => markDestination(location.hash));
  document.querySelectorAll('a[href="#about"], a[href="#how-it-works"], a[href="#contact"]').forEach(link => {
    if (link.hash === '#contact') {
      link.setAttribute('aria-haspopup', 'dialog');
      link.setAttribute('aria-controls', 'contactDialog');
    }
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.hash === '#contact') {
        event.preventDefault();
        contactTrigger = link;
        dialog.showModal();
      } else {
        markDestination(link.hash);
      }
    });
  });
  if (location.hash) markDestination(location.hash);

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
