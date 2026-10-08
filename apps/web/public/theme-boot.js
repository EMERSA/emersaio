// Runs before the first paint, before any stylesheet: picks the theme (the visitor's choice in localStorage, else
// dark, the site's default), marks the document as script-capable for the progressive hooks, and gives the address
// bar the matching colour. It is an external file on purpose: the Content-Security-Policy allows no inline scripts.
(() => {
  const html = document.documentElement;
  let theme = null;
  try {
    theme = localStorage.getItem('em-theme');
  } catch {
    // Storage can be blocked; the default decides instead.
  }
  if (theme !== 'dark' && theme !== 'light') theme = 'dark';
  html.setAttribute('data-theme', theme);
  html.classList.add('js');
  // The two theme-color metas carry one colour each; after this both show the chosen one, whatever the OS says.
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  let color = null;
  for (const meta of metas) {
    if (meta.getAttribute('data-theme-color') === theme) color = meta.getAttribute('content');
  }
  if (color) {
    for (const meta of metas) meta.setAttribute('content', color);
  }
})();
