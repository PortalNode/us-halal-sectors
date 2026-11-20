// المحفظة الافتراضية: رصيد ابتدائي 10,000$ وتداول افتراضي بآخر سعر (بلا عمولات ولا انزلاق).
// الحالة = تواريخ الصفقات فقط في localStorage؛ الأرصدة والمراكز والأداء اليومي تُشتق منها (انظر portfolio-page.js).
// window.Portfolio: { load, save, replay, execute, lastPrice, openTicket, holding, canTrade, ... }
(() => {
  const KEY = 'us-halal-portfolio-v1';
  const START_CASH = 10000;
  const EPS = 1e-9;
  const f2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const f4 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const etDate = (d = new Date()) => NY.format(d);

  // ---------- الحالة ----------
  function fresh() { return { v: 1, startCash: START_CASH, startDate: etDate(), createdAt: new Date().toISOString(), trades: [] }; }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && Array.isArray(s.trades) && Number.isFinite(s.startCash)) return s;
    } catch { /* مخزن غير متاح أو تالف */ }
    const s = fresh();
    save(s);
    return s;
  }
  function save(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('portfolio:change'));
  }
  window.addEventListener('storage', e => { if (e.key === KEY) window.dispatchEvent(new CustomEvent('portfolio:change')); });

  // إعادة تشغيل الصفقات بالترتيب → رصيد نقدي ومراكز (متوسط التكلفة) وربح محقق. upto: تاريخ (يشمل) أو null للكل.
  function replay(state, upto = null) {
    let cash = state.startCash, realized = 0, wins = 0, sells = 0;
    const positions = {};
    for (const t of state.trades) {
      if (upto && t.date > upto) break;
      const p = positions[t.symbol] ||= { symbol: t.symbol, name: t.name, shares: 0, cost: 0 };
      if (t.side === 'buy') { p.shares += t.qty; p.cost += t.total; cash -= t.total; }
      else {
        const avg = p.shares > EPS ? p.cost / p.shares : t.price, basis = avg * t.qty, gain = t.total - basis;
        p.shares -= t.qty; p.cost -= basis; cash += t.total; realized += gain; sells++; if (gain > 0) wins++;
        t.realized = gain;
        if (p.shares < 1e-7) { p.shares = 0; p.cost = 0; }
      }
    }
    for (const k of Object.keys(positions)) if (positions[k].shares < 1e-7) delete positions[k]; else positions[k].avg = positions[k].cost / positions[k].shares;
    return { cash, positions, realized, wins, sells };
  }
  const holding = symbol => replay(load()).positions[symbol] || null;

  // ---------- الأسعار ----------
  let snapPromise = null;
  const snapshot = () => snapPromise ||= fetch('data.json').then(r => r.json()).catch(() => { snapPromise = null; return null; });
  async function stockInfo(symbol) {
    const d = await snapshot();
    for (const sector of d?.sectors || []) { const s = sector.stocks.find(x => x.symbol === symbol); if (s) return { ...s, sector: sector.name }; }
    return null;
  }
  const canTrade = async symbol => !!(await stockInfo(symbol));
  // آخر سعر: لحظي إن توفر الوسيط، وإلا آخر سعر في data.json
  async function lastPrice(symbol) {
    const lq = window.LiveQuotes;
    if (lq?.enabled) {
      const q = (await lq.quotes([symbol])).get(symbol);
      if (q?.price > 0) return { price: q.price, date: lq.dateOf(q) || etDate(), live: q.status && q.status !== 'Closed', status: q.status, source: 'ناسداك · لحظي' };
    }
    const s = await stockInfo(symbol);
    return s?.price > 0 ? { price: s.price, date: s.priceDate || etDate(), live: false, status: null, source: 'آخر سعر معروض في الموقع' } : null;
  }

  // ---------- التنفيذ ----------
  const round = (n, d) => { const m = 10 ** d; return Math.floor(n * m + 1e-9) / m; };
  async function execute({ side, symbol, qty, amount }) {
    const info = await stockInfo(symbol);
    if (!info) return { ok: false, error: 'هذا السهم ليس في القائمة الشرعية.' };
    const quote = await lastPrice(symbol);
    if (!quote) return { ok: false, error: 'تعذر الحصول على سعر السهم الآن.' };
    const state = load(), now = replay(state), price = quote.price;
    if (amount != null && qty == null) qty = round(amount / price, 4);
    qty = round(Number(qty), 4);
    if (!(qty > 0)) return { ok: false, error: 'أدخل كمية أو مبلغًا أكبر من صفر.' };
    const total = Math.round(qty * price * 1e6) / 1e6;
    if (side === 'buy' && total > now.cash + 0.005) return { ok: false, error: `الرصيد النقدي غير كافٍ: المتاح ${f2.format(now.cash)}$ والمطلوب ${f2.format(total)}$.` };
    const held = now.positions[symbol]?.shares || 0;
    if (side === 'sell' && qty > held + EPS) return { ok: false, error: `لا تملك هذه الكمية: المتاح للبيع ${f4.format(held)} سهمًا.` };
    const trade = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, t: new Date().toISOString(), date: quote.date, symbol, name: info.name, side, qty, price, total, source: quote.source };
    // التاريخ لا يتراجع عن آخر صفقة (ترتيب إعادة التشغيل)
    const last = state.trades.at(-1);
    if (last && trade.date < last.date) trade.date = last.date;
    state.trades.push(trade);
    save(state);
    return { ok: true, trade, cash: replay(state).cash };
  }

  // ---------- نافذة الأمر ----------
  function ensureStyle() {
    if (document.getElementById('pf-style')) return;
    const link = document.createElement('link');
    link.id = 'pf-style'; link.rel = 'stylesheet'; link.href = 'portfolio.css?v=3';
    document.head.appendChild(link);
  }
  let dialog = null;
  async function openTicket(symbol = null, side = 'buy') {
    ensureStyle();
    closeTicket();
    const state = { symbol, side, mode: 'qty', price: null, quote: null, stocks: [], busy: false };
    const snap = await snapshot();
    state.stocks = (snap?.sectors || []).flatMap(s => s.stocks);
    const root = document.createElement('div');
    root.className = 'pf-overlay';
    root.innerHTML = '<div class="pf-dialog" role="dialog" aria-modal="true" aria-labelledby="pf-title"></div>';
    document.body.appendChild(root);
    dialog = root;
    const box = root.firstElementChild;
    let timer = null;

    const stockOf = () => state.stocks.find(s => s.symbol === state.symbol);
    async function refreshPrice() {
      if (!state.symbol) return;
      const q = await lastPrice(state.symbol);
      if (!dialog || !q) return;
      state.quote = q; state.price = q.price;
      paintPrice();
    }
    function paintPrice() {
      const el = box.querySelector('[data-pf-price]');
      if (!el || !state.quote) return;
      const q = state.quote;
      el.innerHTML = `<b>${f2.format(q.price)}$</b><small>${q.live ? '<i class="pf-live">●</i> لحظي' : 'آخر سعر متاح'} · ${esc(q.source)}</small>`;
      paintEstimate();
    }
    function inputValue() { return Number(box.querySelector('[data-pf-input]')?.value || 0); }
    function paintEstimate() {
      const est = box.querySelector('[data-pf-est]'), btn = box.querySelector('[data-pf-confirm]');
      if (!est || !state.price) return;
      const v = inputValue(), now = replay(load()), held = now.positions[state.symbol]?.shares || 0;
      let qty = state.mode === 'qty' ? v : round(v / state.price, 4), total = qty * state.price;
      est.textContent = v > 0 ? (state.mode === 'qty' ? `≈ ${f2.format(total)}$` : `≈ ${f4.format(qty)} سهم`) : '—';
      if (btn) btn.disabled = !(v > 0) || state.busy;
    }
    function render(message = '') {
      const now = replay(load()), stock = stockOf(), pos = state.symbol ? now.positions[state.symbol] : null;
      const buy = state.side === 'buy';
      box.innerHTML = `
        <div class="pf-head"><h3 id="pf-title">${stock ? `<img class="co-logo co-logo-md" src="logos/${esc(stock.symbol)}.svg" alt="" onerror="this.remove()"> ${esc(stock.name)} <bdi class="symbol-badge">${esc(stock.symbol)}</bdi>` : 'محفظة افتراضية · اختر سهمًا'}</h3><button type="button" class="pf-x" data-pf-close aria-label="إغلاق">×</button></div>
        ${stock ? '' : `<div class="pf-search"><input type="search" data-pf-search placeholder="ابحث باسم الشركة أو الرمز" autocomplete="off" autofocus><ul data-pf-results></ul></div>`}
        ${stock ? `
        <div class="pf-price" data-pf-price><b>—</b></div>
        <div class="pf-tabs" role="tablist"><button type="button" role="tab" data-pf-side="buy" aria-selected="${buy}">شراء</button><button type="button" role="tab" data-pf-side="sell" aria-selected="${!buy}">بيع</button></div>
        <div class="pf-grid">
          <div><span>النقد المتاح</span><b>${f2.format(now.cash)}$</b></div>
          <div><span>تملك</span><b>${pos ? `${f4.format(pos.shares)} سهم` : '0'}</b></div>
          <div><span>متوسط التكلفة</span><b>${pos ? `${f2.format(pos.avg)}$` : '—'}</b></div>
        </div>
        <div class="pf-mode"><button type="button" data-pf-mode="qty" aria-pressed="${state.mode === 'qty'}">عدد الأسهم</button><button type="button" data-pf-mode="amount" aria-pressed="${state.mode === 'amount'}">المبلغ ($)</button></div>
        <div class="pf-field"><input type="number" inputmode="decimal" min="0" step="any" data-pf-input placeholder="${state.mode === 'qty' ? 'عدد الأسهم' : 'المبلغ بالدولار'}" dir="ltr"><span data-pf-est>—</span></div>
        <div class="pf-quick">${[25, 50, 75, 100].map(p => `<button type="button" data-pf-pct="${p}">${p}%</button>`).join('')}</div>
        <button type="button" class="pf-confirm ${buy ? 'buy' : 'sell'}" data-pf-confirm disabled>${buy ? 'تنفيذ شراء افتراضي' : 'تنفيذ بيع افتراضي'}</button>` : ''}
        <p class="pf-msg" data-pf-msg role="status">${message}</p>
        <p class="pf-note">تداول افتراضي بآخر سعر متاح، بلا عمولات ولا انزلاق، وليس توصية استثمارية. المحفظة محفوظة في هذا المتصفح فقط.</p>`;
      if (stock) { paintPrice(); refreshPrice(); }
      else box.querySelector('[data-pf-search]')?.focus();
    }
    function fillPct(p) {
      const now = replay(load()), input = box.querySelector('[data-pf-input]');
      if (!input || !state.price) return;
      if (state.side === 'buy') {
        const cash = now.cash * p / 100;
        input.value = state.mode === 'qty' ? String(round(cash / state.price, 4)) : String(Math.floor(cash * 100) / 100);
      } else {
        const held = (now.positions[state.symbol]?.shares || 0) * p / 100;
        input.value = state.mode === 'qty' ? String(round(held, 4)) : String(Math.floor(held * state.price * 100) / 100);
      }
      paintEstimate();
    }
    function searchResults(q) {
      const norm = x => String(x || '').toLowerCase();
      const needle = norm(q).trim();
      const list = needle ? state.stocks.filter(s => norm(s.symbol).includes(needle) || norm(s.name).includes(needle) || norm(s.nameEn).includes(needle)).slice(0, 8) : [...state.stocks].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, 8);
      box.querySelector('[data-pf-results]').innerHTML = list.map(s => `<li><button type="button" data-pf-pick="${esc(s.symbol)}"><b>${esc(s.symbol)}</b> ${esc(s.name)} <small>${esc(s.nameEn || '')}</small></button></li>`).join('') || '<li class="pf-empty">لا نتائج</li>';
    }

    root.addEventListener('click', async e => {
      if (e.target === root || e.target.closest('[data-pf-close]')) return closeTicket();
      const pick = e.target.closest('[data-pf-pick]'); if (pick) { state.symbol = pick.dataset.pfPick; state.quote = null; return render(); }
      const sideBtn = e.target.closest('[data-pf-side]'); if (sideBtn) { state.side = sideBtn.dataset.pfSide; return render(); }
      const modeBtn = e.target.closest('[data-pf-mode]'); if (modeBtn) { state.mode = modeBtn.dataset.pfMode; return render(); }
      const pct = e.target.closest('[data-pf-pct]'); if (pct) return fillPct(Number(pct.dataset.pfPct));
      if (e.target.closest('[data-pf-confirm]') && !state.busy) {
        state.busy = true; paintEstimate();
        const v = inputValue();
        const r = await execute({ side: state.side, symbol: state.symbol, ...(state.mode === 'qty' ? { qty: v } : { amount: v }) });
        state.busy = false;
        if (!dialog) return;
        if (!r.ok) { render(); box.querySelector('[data-pf-msg]').innerHTML = `<span class="pf-err">${esc(r.error)}</span>`; return; }
        const t = r.trade;
        render(`<span class="pf-ok">✓ تم ${t.side === 'buy' ? 'شراء' : 'بيع'} ${f4.format(t.qty)} من ${esc(t.symbol)} بسعر ${f2.format(t.price)}$ (الإجمالي ${f2.format(t.total)}$).</span>`);
      }
    });
    root.addEventListener('input', e => { if (e.target.matches('[data-pf-input]')) paintEstimate(); if (e.target.matches('[data-pf-search]')) searchResults(e.target.value); });
    const onKey = e => { if (e.key === 'Escape') closeTicket(); };
    document.addEventListener('keydown', onKey);
    timer = setInterval(refreshPrice, 2000);
    root._cleanup = () => { clearInterval(timer); document.removeEventListener('keydown', onKey); };
    render();
    if (!symbol) searchResults('');
  }
  function closeTicket() {
    if (!dialog) return;
    dialog._cleanup?.();
    dialog.remove();
    dialog = null;
  }

  window.Portfolio = { KEY, START_CASH, load, save, fresh, replay, execute, lastPrice, stockInfo, snapshot, canTrade, holding, openTicket, closeTicket, etDate, ensureStyle };

  // أزرار «data-pf-trade="buy|sell"» في أي صفحة تفتح نافذة الأمر (data-pf-symbol أو الرمز من الصفحة)
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-pf-trade]');
    if (!b) return;
    e.preventDefault();
    openTicket(b.dataset.pfSymbol || null, b.dataset.pfTrade === 'sell' ? 'sell' : 'buy');
  });
})();
