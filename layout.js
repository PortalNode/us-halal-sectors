// Layout helpers shared by every page (columns view, status line, company logos). They only rearrange what the page
// scripts already render; no prices or financial values are computed here.
(() => {
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

  // ----- Home page: column views -----
  const sections = document.getElementById('sectors');
  const views = document.getElementById('col-views');
  if (sections && views) {
    const allowed = ['val', 'perf', 'trade', 'all'];
    const apply = (view, persist) => {
      if (!allowed.includes(view)) view = 'val';
      sections.dataset.cols = view;
      for (const button of views.querySelectorAll('button[data-cols]')) {
        button.setAttribute('aria-pressed', String(button.dataset.cols === view));
      }
      const eps = document.querySelector('.table-tools .eps-switch');
      if (eps) eps.hidden = view === 'perf' || view === 'trade';
      if (persist) write('us-halal-columns', view);
      // The sticky header measures the table; let it re-measure the new width.
      window.dispatchEvent(new Event('resize'));
    };
    views.addEventListener('click', event => {
      const button = event.target.closest('button[data-cols]');
      if (button) apply(button.dataset.cols, true);
    });
    apply(read('us-halal-columns') || sections.dataset.cols || 'val', false);
  }

  // ----- Home page: one-line copy of the price status -----
  const status = document.getElementById('price-status');
  const brief = document.getElementById('status-brief');
  if (status && brief) {
    const mirror = () => { brief.textContent = status.textContent; brief.title = status.textContent; };
    new MutationObserver(mirror).observe(status, { childList: true, characterData: true, subtree: true });
    mirror();
  }

  // ----- Company logos -----
  // dist/logos/<symbol>.svg from TradingView (scripts/fetch-logos.mjs); manifest.json lists
  // the symbols that have one. A company without a logo gets the first letter of its name.
  // Added beside what the pages render: the company heading, the home table and the chart search.
  const logoSymbols = fetch('logos/manifest.json?v=1')
    .then(res => (res.ok ? res.json() : { symbols: [] }))
    .then(manifest => new Set(manifest.symbols))
    .catch(() => new Set());
  const letterLogo = (name, size) => {
    const span = document.createElement('span');
    span.className = `co-logo co-logo-letter co-logo-${size}`;
    span.textContent = (name || '').trim().charAt(0);
    return span;
  };
  const makeLogo = (symbol, name, size, have) => {
    if (!have.has(symbol)) return letterLogo(name, size);
    const img = document.createElement('img');
    img.className = `co-logo co-logo-${size}`;
    img.src = `logos/${symbol}.svg`;
    img.alt = '';
    img.decoding = 'async';
    if (size === 'sm') img.loading = 'lazy';
    img.addEventListener('error', () => img.replaceWith(letterLogo(name, size)), { once: true });
    return img;
  };
  // Puts the logo first in `host`, replacing one left from another company.
  const placeLogo = (host, symbol, name, size, have) => {
    if (!symbol) return;
    const old = host.querySelector(':scope > .co-logo');
    if (old?.dataset.symbol === symbol) return;
    const logo = makeLogo(symbol, name, size, have);
    logo.dataset.symbol = symbol;
    logo.setAttribute('aria-hidden', 'true');
    if (old) old.replaceWith(logo); else host.prepend(logo);
    host.classList.add('has-co-logo');
  };
  const nameOf = el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && !n.matches('.co-logo, .symbol-badge'))).map(n => n.textContent).join('').trim();
  const addLogos = have => {
    for (const heading of document.querySelectorAll('.bank-heading h2')) {
      placeLogo(heading, heading.querySelector('.symbol-badge')?.textContent.trim(), nameOf(heading), 'lg', have);
    }
    for (const cell of document.querySelectorAll('tbody td.company-name')) {
      placeLogo(cell, cell.closest('tr')?.querySelector('.symbol-badge')?.textContent.trim(), nameOf(cell), 'sm', have);
    }
    for (const button of document.querySelectorAll('.cc-search-btn')) {
      const symbol = button.querySelector('b')?.textContent.trim();
      const old = button.querySelector('.co-logo');
      if (!symbol || old?.dataset.symbol === symbol) continue;
      old?.remove();
      const logo = makeLogo(symbol, button.querySelector('.cc-search-name')?.textContent, 'xs', have);
      logo.dataset.symbol = symbol;
      logo.setAttribute('aria-hidden', 'true');
      button.querySelector('b').before(logo);
    }
  };
  logoSymbols.then(have => {
    let queued = false;
    const run = () => { queued = false; addLogos(have); };
    // A microtask runs before the next paint, so a new heading or row never shows without its logo.
    new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(run); } })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
    run();
  });
})();
