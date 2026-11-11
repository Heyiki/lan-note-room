(() => {
  const key = 'lan-note-room-theme';
  let theme = 'dark';
  try {
    if (localStorage.getItem(key) === 'light') theme = 'light';
  } catch { /* Browser storage may be disabled. */ }

  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#181a1d' : '#f5f6f8';
    for (const button of document.querySelectorAll('[data-theme-choice]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
    }
  }

  applyTheme();
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-theme-choice]');
    if (!button) return;
    theme = button.dataset.themeChoice;
    if (theme !== 'dark' && theme !== 'light') return;
    try { localStorage.setItem(key, theme); } catch { /* Keep the in-page choice. */ }
    applyTheme();
  });
})();
