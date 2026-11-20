// المحفظة الافتراضية: رصيد ابتدائي 10,000$ وتداول افتراضي (أوامر سوقية بآخر سعر، وأوامر بحد سعر معلّقة)، بلا عمولات ولا انزلاق.
// الحالة = الصفقات والأوامر فقط في localStorage؛ الأرصدة والمراكز والأداء اليومي تُشتق منها (انظر portfolio-page.js).
// الأوامر المعلّقة (حد سعر) تُنفَّذ أثناء فتح أي صفحة من الموقع (مراقب يعمل كل 3 ثوانٍ مع الوسيط اللحظي)،
// وعند فتح الموقع لاحقًا تُفحص بشموع الأيام التي مرّت منذ وضع الأمر.
// window.Portfolio: { load, save, replay, execute, placeOrder, cancelOrder, lastPrice, equityNow, openTicket, holding, ... }
(() => {
  const KEY = 'us-halal-portfolio-v1';
  const START_CASH = 10000;
  const EPS = 1e-9;
  const f2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const f4 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const etDate = (d = new Date()) => NY.format(d);
  const round = (n, d) => { const m = 10 ** d; return Math.floor(n * m + 1e-9) / m; };
  const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // ---------- الحالة ----------
  function fresh() { return { v: 1, startCash: START_CASH, startDate: etDate(), createdAt: new Date().toISOString(), trades: [], orders: [] }; }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && Array.isArray(s.trades) && Number.isFinite(s.startCash)) { s.orders = Array.isArray(s.orders) ? s.orders : []; return s; }
    } catch { /* مخزن غير متاح أو تالف */ }
    const s = fresh();
    save(s);
    return s;
  }
  function save(state, silent = false) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
    if (!silent) window.dispatchEvent(new CustomEvent('portfolio:change'));
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

  // ---------- الأوامر المعلّقة: حجز النقد والأسهم ----------
  const openOrders = (state, symbol = null) => state.orders.filter(o => o.status === 'open' && (!symbol || o.symbol === symbol));
  function reservedOf(state, excludeId = null) {
    let cash = 0;
    const shares = {};
    for (const o of openOrders(state)) {
      if (o.id === excludeId) continue;
      if (o.side === 'buy') cash += o.qty * o.limit; else shares[o.symbol] = (shares[o.symbol] || 0) + o.qty;
    }
    return { cash, shares };
  }
  // المتاح فعليًا للأمر الجديد: النقد بعد حجز أوامر الشراء المعلّقة، والأسهم الحرة بعد حجز أوامر البيع المعلّقة
  function availability(state, symbol, excludeId = null) {
    const now = replay(state), res = reservedOf(state, excludeId), held = now.positions[symbol]?.shares || 0;
    return { cash: now.cash - res.cash, cashTotal: now.cash, reservedCash: res.cash, held, free: held - (res.shares[symbol] || 0) };
  }
  // إدراج صفقة مع الحفاظ على ترتيب التواريخ (ثابت داخل اليوم الواحد)
  function appendTrade(state, trade) {
    state.trades.push(trade);
    state.trades = state.trades.map((t, i) => [t, i]).sort((a, b) => a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : a[1] - b[1]).map(x => x[0]);
  }

  // ---------- الأسعار ----------
  let snapPromise = null;
  const snapshot = () => snapPromise ||= fetch('data.json').then(r => r.json()).catch(() => { snapPromise = null; return null; });
  async function stockInfo(symbol) {
    const d = await snapshot();
    for (const sector of d?.sectors || []) { const s = sector.stocks.find(x => x.symbol === symbol); if (s) return { ...s, sector: sector.name }; }
    return null;
  }
  const canTrade = async symbol => !!(await stockInfo(symbol));
  const quoteResult = (q, lq) => ({ price: q.price, date: lq.dateOf(q) || etDate(), live: !!q.status && q.status !== 'Closed', status: q.status, source: 'ناسداك · لحظي' });
  // آخر سعر: لحظي إن توفر الوسيط، وإلا آخر سعر في data.json
  async function lastPrice(symbol) {
    const lq = window.LiveQuotes;
    if (lq?.enabled) {
      const q = (await lq.quotes([symbol])).get(symbol);
      if (q?.price > 0) return quoteResult(q, lq);
    }
    const s = await stockInfo(symbol);
    return s?.price > 0 ? { price: s.price, date: s.priceDate || etDate(), live: false, status: null, source: 'آخر سعر معروض في الموقع' } : null;
  }
  // قيمة المحفظة الآن (نقد + مراكز بأحدث الأسعار) وأسعار الرموز المطلوبة معها في طلب واحد
  async function equityNow(extra = []) {
    const state = load(), now = replay(state), held = Object.keys(now.positions), lq = window.LiveQuotes;
    const live = lq?.enabled ? await lq.quotes([...new Set([...held, ...extra])]) : new Map();
    const snap = await snapshot(), stocks = new Map((snap?.sectors || []).flatMap(s => s.stocks).map(s => [s.symbol, s]));
    const priceOf = sym => live.get(sym)?.price ?? stocks.get(sym)?.price ?? null;
    const value = Object.values(now.positions).reduce((a, p) => a + (priceOf(p.symbol) ?? p.avg) * p.shares, 0);
    return { equity: now.cash + value, cash: now.cash, value, live, priceOf };
  }

  // ---------- التنفيذ ----------
  const tradeOf = (info, side, symbol, qty, price, date, source) => ({ id: uid(), t: new Date().toISOString(), date, symbol, name: info.name, side, qty, price, total: Math.round(qty * price * 1e6) / 1e6, source });
  async function execute({ side, symbol, qty, amount }) {
    const info = await stockInfo(symbol);
    if (!info) return { ok: false, error: 'هذا السهم ليس في القائمة الشرعية.' };
    const quote = await lastPrice(symbol);
    if (!quote) return { ok: false, error: 'تعذر الحصول على سعر السهم الآن.' };
    const state = load(), av = availability(state, symbol), price = quote.price;
    if (amount != null && qty == null) qty = round(amount / price, 4);
    qty = round(Number(qty), 4);
    if (!(qty > 0)) return { ok: false, error: 'أدخل كمية أو مبلغًا أكبر من صفر.' };
    const total = qty * price;
    if (side === 'buy' && total > av.cash + 0.005) return { ok: false, error: `النقد المتاح غير كافٍ: ${f2.format(av.cash)}$${av.reservedCash > 0 ? ` (بعد حجز ${f2.format(av.reservedCash)}$ لأوامر معلّقة)` : ''} والمطلوب ${f2.format(total)}$.` };
    if (side === 'sell' && qty > av.free + EPS) return { ok: false, error: `لا تملك هذه الكمية: المتاح للبيع ${f4.format(Math.max(av.free, 0))} سهمًا${av.held > av.free ? ' (الباقي محجوز لأوامر بيع معلّقة)' : ''}.` };
    const trade = tradeOf(info, side, symbol, qty, price, quote.date, quote.source);
    const last = state.trades.at(-1);
    if (last && trade.date < last.date) trade.date = last.date;
    appendTrade(state, trade);
    save(state);
    return { ok: true, trade, cash: replay(state).cash };
  }

  // أمر بحد سعر: شراء عند السعر أو أقل، بيع عند السعر أو أعلى. إن كان السعر الحالي يحقق الشرط فورًا نُفِّذ بالسعر الحالي (أفضل).
  async function placeOrder({ side, symbol, qty, amount, limit }) {
    limit = Math.round(Number(limit) * 10000) / 10000;
    if (!(limit > 0)) return { ok: false, error: 'أدخل سعرًا أكبر من صفر.' };
    const info = await stockInfo(symbol);
    if (!info) return { ok: false, error: 'هذا السهم ليس في القائمة الشرعية.' };
    const quote = await lastPrice(symbol);
    if (!quote) return { ok: false, error: 'تعذر الحصول على سعر السهم الآن.' };
    if (amount != null && qty == null) qty = round(amount / limit, 4);
    qty = round(Number(qty), 4);
    if (!(qty > 0)) return { ok: false, error: 'أدخل كمية أو مبلغًا أكبر من صفر.' };
    if ((side === 'buy' && quote.price <= limit) || (side === 'sell' && quote.price >= limit)) {
      const r = await execute({ side, symbol, qty });
      return r.ok ? { ...r, immediate: true } : r;
    }
    const state = load(), av = availability(state, symbol);
    if (side === 'buy' && qty * limit > av.cash + 0.005) return { ok: false, error: `النقد المتاح غير كافٍ لحجز الأمر: ${f2.format(av.cash)}$ والمطلوب ${f2.format(qty * limit)}$.` };
    if (side === 'sell' && qty > av.free + EPS) return { ok: false, error: `لا تملك هذه الكمية حرّة: المتاح ${f4.format(Math.max(av.free, 0))} سهمًا.` };
    const order = { id: uid(), createdAt: new Date().toISOString(), date: quote.date, symbol, name: info.name, side, qty, limit, status: 'open', marketAtCreate: quote.price };
    state.orders.push(order);
    save(state);
    startWatcher();
    return { ok: true, order, pending: true };
  }
  function cancelOrder(id) {
    const state = load(), o = state.orders.find(x => x.id === id && x.status === 'open');
    if (!o) return false;
    o.status = 'cancelled'; o.closedAt = new Date().toISOString();
    save(state);
    return true;
  }

  // تنفيذ أمر معلّق بسعر ما (التحقق من النقد/الأسهم وقت التنفيذ بعد استبعاد حجز الأمر نفسه)
  function fillOrder(state, order, price, date, source) {
    const av = availability(state, order.symbol, order.id), total = order.qty * price;
    if (order.side === 'buy' && total > av.cash + 0.005) { Object.assign(order, { status: 'rejected', closedAt: new Date().toISOString(), reason: 'النقد غير كافٍ وقت التنفيذ' }); return null; }
    if (order.side === 'sell' && order.qty > av.free + EPS) { Object.assign(order, { status: 'rejected', closedAt: new Date().toISOString(), reason: 'الأسهم غير كافية وقت التنفيذ' }); return null; }
    const trade = tradeOf({ name: order.name }, order.side, order.symbol, order.qty, price, date, source);
    trade.orderId = order.id;
    appendTrade(state, trade);
    Object.assign(order, { status: 'filled', closedAt: new Date().toISOString(), fillPrice: price, fillDate: trade.date, tradeId: trade.id });
    return trade;
  }
  const withLock = fn => navigator.locks?.request ? navigator.locks.request('us-halal-portfolio', fn) : fn();

  // أسعار لحظية → تنفيذ الأوامر التي تحقق شرطها. quotes: Map(رمز → {price,status,time})
  function processOrders(quotes) {
    return withLock(async () => {
      const state = load(), lq = window.LiveQuotes, filled = [];
      for (const o of openOrders(state)) {
        const q = quotes.get(o.symbol);
        if (!(q?.price > 0)) continue;
        const hit = o.side === 'buy' ? q.price <= o.limit : q.price >= o.limit;
        if (!hit) continue;
        // سعر التنفيذ: الأفضل للمستخدم بين سعر الأمر والسعر الحالي
        const price = o.side === 'buy' ? Math.min(o.limit, q.price) : Math.max(o.limit, q.price);
        filled.push({ o, t: fillOrder(state, o, price, lq?.dateOf?.(q) || etDate(), 'أمر بحد سعر · لحظي') });
      }
      if (filled.length) { save(state); filled.forEach(({ o, t }) => toast(t ? `تم تنفيذ أمرك: ${o.side === 'buy' ? 'شراء' : 'بيع'} ${f4.format(o.qty)} من ${o.symbol} بسعر ${f2.format(t.price)}$` : `أُلغي أمر ${o.symbol}: ${o.reason}`)); }
      return filled.length;
    });
  }
  // أيام مرّت منذ وضع الأمر (الموقع كان مغلقًا): إن لامس سعر اليوم (أدنى/أعلى) سعر الأمر نُفّذ بسعر الأمر. يوم وضع الأمر نفسه لا يُفحص (التوقيت داخل اليوم مجهول).
  async function backfill() {
    const orders = openOrders(load());
    if (!orders.length) return 0;
    const files = new Map();
    for (const sym of new Set(orders.map(o => o.symbol))) {
      try { const r = await fetch(`ohlc/${encodeURIComponent(sym)}.json`, { cache: 'no-cache' }); files.set(sym, r.ok ? await r.json() : null); } catch { files.set(sym, null); }
    }
    return withLock(async () => {
      const state = load(), filled = [];
      for (const o of openOrders(state)) {
        const f = files.get(o.symbol);
        if (!f?.d) continue;
        const i = f.d.findIndex((d, k) => d > o.date && (o.side === 'buy' ? f.l[k] <= o.limit : f.h[k] >= o.limit));
        if (i < 0) continue;
        filled.push({ o, t: fillOrder(state, o, o.limit, f.d[i], 'أمر بحد سعر · من شموع الإغلاق') });
      }
      if (filled.length) { save(state); filled.forEach(({ o, t }) => toast(t ? `تم تنفيذ أمرك المعلّق: ${o.side === 'buy' ? 'شراء' : 'بيع'} ${f4.format(o.qty)} من ${o.symbol} بسعر ${f2.format(t.price)}$ (${t.date})` : `أُلغي أمر ${o.symbol}: ${o.reason}`)); }
      return filled.length;
    });
  }

  // ---------- مراقب الأوامر ----------
  let watchTimer = null, lastBackfill = 0, watching = false;
  async function tickOrders() {
    const open = openOrders(load());
    if (!open.length || document.hidden) return;
    const symbols = [...new Set(open.map(o => o.symbol))], lq = window.LiveQuotes;
    let quotes = new Map();
    if (lq?.enabled) quotes = await lq.quotes(symbols);
    else { const snap = await snapshot(); for (const s of (snap?.sectors || []).flatMap(x => x.stocks)) if (symbols.includes(s.symbol)) quotes.set(s.symbol, { price: s.price }); }
    if (quotes.size) await processOrders(quotes);
    if (Date.now() - lastBackfill > 5 * 60 * 1000) { lastBackfill = Date.now(); await backfill(); }
  }
  function startWatcher() {
    if (watching) return;
    watching = true;
    const loop = () => {
      const lq = window.LiveQuotes;
      watchTimer = setTimeout(async () => { try { await tickOrders(); } catch { /* يُعاد في الدورة التالية */ } loop(); }, lq?.enabled && lq.isExtendedHours() ? 3000 : 60000);
    };
    tickOrders().catch(() => {}).finally(loop);
  }
  window.addEventListener('portfolio:change', () => { if (openOrders(load()).length) startWatcher(); });

  // ---------- إشعار صغير ----------
  function toast(message) {
    ensureStyle();
    const el = document.createElement('div');
    el.className = 'pf-toast';
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 8000);
  }

  // ---------- نافذة الأمر ----------
  function ensureStyle() {
    if (document.getElementById('pf-style')) return;
    const link = document.createElement('link');
    link.id = 'pf-style'; link.rel = 'stylesheet'; link.href = 'portfolio.css?v=4';
    document.head.appendChild(link);
  }
  const PCTS = [5, 10, 15, 20, 25, 50, 75, 100];
  let dialog = null;
  async function openTicket(symbol = null, side = 'buy') {
    ensureStyle();
    closeTicket();
    const state = { symbol, side, type: 'market', mode: 'qty', price: null, quote: null, equity: null, stocks: [], busy: false, limit: '' };
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
    const unitPrice = () => state.type === 'limit' ? Number(box.querySelector('[data-pf-limit]')?.value || 0) : state.price; // سعر الحساب: حد السعر أو السوق
    async function refreshPrice() {
      if (!state.symbol) return;
      const [q, eq] = await Promise.all([lastPrice(state.symbol), equityNow([state.symbol])]);
      if (!dialog || !q) return;
      state.quote = q; state.price = q.price; state.equity = eq.equity;
      paintPrice();
    }
    function paintPrice() {
      const el = box.querySelector('[data-pf-price]');
      if (!el || !state.quote) return;
      const q = state.quote;
      el.innerHTML = `<b>${f2.format(q.price)}$</b><small>${q.live ? '<i class="pf-live">●</i> لحظي' : 'آخر سعر متاح'} · ${esc(q.source)}</small>`;
      const eq = box.querySelector('[data-pf-equity]');
      if (eq && state.equity != null) eq.textContent = f2.format(state.equity);
      paintEstimate();
    }
    function inputValue() { return Number(box.querySelector('[data-pf-input]')?.value || 0); }
    function paintEstimate() {
      const est = box.querySelector('[data-pf-est]'), btn = box.querySelector('[data-pf-confirm]'), hint = box.querySelector('[data-pf-hint]');
      if (!est) return;
      const px = unitPrice(), v = inputValue();
      const qty = state.mode === 'qty' ? v : (px > 0 ? round(v / px, 4) : 0), total = qty * px;
      est.textContent = v > 0 && px > 0 ? (state.mode === 'qty' ? `≈ ${f2.format(total)}$` : `≈ ${f4.format(qty)} سهم`) : '—';
      if (hint && state.type === 'limit' && state.price && px > 0) {
        const marketable = (state.side === 'buy' && state.price <= px) || (state.side === 'sell' && state.price >= px);
        hint.innerHTML = marketable ? `السعر الحالي ${f2.format(state.price)}$ يحقق شرطك، فيُنفَّذ الأمر <b>فورًا</b> بالسعر الحالي.` : `يُنفَّذ الأمر عندما يصل السعر إلى ${f2.format(px)}$ أو ${state.side === 'buy' ? 'أقل' : 'أعلى'} (${f2.format((px / state.price - 1) * 100)}% عن الحالي).`;
      }
      if (btn) btn.disabled = !(v > 0) || !(px > 0) || state.busy;
    }
    function render(message = '') {
      const st = load(), av = state.symbol ? availability(st, state.symbol) : null, stock = stockOf(), pos = state.symbol ? replay(st).positions[state.symbol] : null;
      const buy = state.side === 'buy', limit = state.type === 'limit', mine = state.symbol ? openOrders(st, state.symbol) : [];
      const confirmText = limit ? (buy ? 'وضع أمر شراء بحد سعر' : 'وضع أمر بيع بحد سعر') : (buy ? 'تنفيذ شراء افتراضي' : 'تنفيذ بيع افتراضي');
      box.innerHTML = `
        <div class="pf-head"><h3 id="pf-title">${stock ? `<img class="co-logo co-logo-md" src="logos/${esc(stock.symbol)}.svg" alt="" onerror="this.remove()"> ${esc(stock.name)} <bdi class="symbol-badge">${esc(stock.symbol)}</bdi>` : 'محفظة افتراضية · اختر سهمًا'}</h3><button type="button" class="pf-x" data-pf-close aria-label="إغلاق">×</button></div>
        ${stock ? '' : `<div class="pf-search"><input type="search" data-pf-search placeholder="ابحث باسم الشركة أو الرمز" autocomplete="off" autofocus><ul data-pf-results></ul></div>`}
        ${stock ? `
        <div class="pf-price" data-pf-price><b>—</b></div>
        <div class="pf-tabs" role="tablist"><button type="button" role="tab" data-pf-side="buy" aria-selected="${buy}">شراء</button><button type="button" role="tab" data-pf-side="sell" aria-selected="${!buy}">بيع</button></div>
        <div class="pf-mode"><button type="button" data-pf-type="market" aria-pressed="${!limit}">سوقي (بالسعر الحالي)</button><button type="button" data-pf-type="limit" aria-pressed="${limit}">بحد سعر</button></div>
        <div class="pf-grid">
          <div><span>النقد المتاح</span><b>${f2.format(av.cash)}$</b></div>
          <div><span>تملك${av.held > av.free + EPS ? ' (حرّ)' : ''}</span><b>${pos ? `${f4.format(av.free)} سهم` : '0'}</b></div>
          <div><span>متوسط التكلفة</span><b>${pos ? `${f2.format(pos.avg)}$` : '—'}</b></div>
        </div>
        ${av.reservedCash > 0 ? `<p class="pf-note">محجوز ${f2.format(av.reservedCash)}$ من النقد لأوامر شراء معلّقة.</p>` : ''}
        ${limit ? `<div class="pf-limit"><label>سعر الأمر ($)<input type="number" inputmode="decimal" min="0" step="any" data-pf-limit dir="ltr" value="${esc(state.limit)}"></label><div class="pf-quick pf-quick3">${(buy ? [-1, -2, -5] : [1, 2, 5]).map(p => `<button type="button" data-pf-lp="${p}">${p > 0 ? '+' : ''}${p}%</button>`).join('')}</div><p class="pf-note" data-pf-hint></p></div>` : ''}
        <div class="pf-mode"><button type="button" data-pf-mode="qty" aria-pressed="${state.mode === 'qty'}">عدد الأسهم</button><button type="button" data-pf-mode="amount" aria-pressed="${state.mode === 'amount'}">المبلغ ($)</button></div>
        <div class="pf-field"><input type="number" inputmode="decimal" min="0" step="any" data-pf-input placeholder="${state.mode === 'qty' ? 'عدد الأسهم' : 'المبلغ بالدولار'}" dir="ltr"><span data-pf-est>—</span></div>
        <div class="pf-quick pf-quick4">${PCTS.map(p => `<button type="button" data-pf-pct="${p}">${p}%</button>`).join('')}</div>
        <p class="pf-note">${buy ? `النسبة من <b>قيمة المحفظة</b> (<span data-pf-equity>—</span>$) وبحد أقصى النقد المتاح.` : 'النسبة من الأسهم التي تملكها (الحرّة غير المحجوزة).'}</p>
        <button type="button" class="pf-confirm ${buy ? 'buy' : 'sell'}" data-pf-confirm disabled>${confirmText}</button>
        ${mine.length ? `<div class="pf-mine"><b>أوامرك المعلّقة على هذا السهم</b>${mine.map(o => `<div><span>${o.side === 'buy' ? 'شراء' : 'بيع'} ${f4.format(o.qty)} عند ${f2.format(o.limit)}$</span><button type="button" data-pf-cancel="${esc(o.id)}">إلغاء</button></div>`).join('')}</div>` : ''}` : ''}
        <p class="pf-msg" data-pf-msg role="status">${message}</p>
        <p class="pf-note">تداول افتراضي بلا عمولات ولا انزلاق، وليس توصية استثمارية. الأوامر السوقية بآخر سعر متاح، والمعلّقة تُنفَّذ أثناء فتحك الموقع أو عند فتحه لاحقًا. المحفظة محفوظة في هذا المتصفح فقط.</p>`;
      if (stock) { paintPrice(); refreshPrice(); }
      else box.querySelector('[data-pf-search]')?.focus();
    }
    function fillPct(p) {
      const st = load(), av = availability(st, state.symbol), input = box.querySelector('[data-pf-input]'), px = unitPrice();
      if (!input || !(px > 0)) return;
      let qty;
      if (state.side === 'buy') qty = round(Math.min((state.equity ?? replay(st).cash) * p / 100, av.cash) / px, 4);
      else qty = round(av.free * p / 100, 4);
      input.value = state.mode === 'qty' ? String(qty) : String(Math.floor(qty * px * 100) / 100);
      paintEstimate();
    }
    function searchResults(q) {
      const norm = x => String(x || '').toLowerCase();
      const needle = norm(q).trim();
      const list = needle ? state.stocks.filter(s => norm(s.symbol).includes(needle) || norm(s.name).includes(needle) || norm(s.nameEn).includes(needle)).slice(0, 8) : [...state.stocks].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, 8);
      box.querySelector('[data-pf-results]').innerHTML = list.map(s => `<li><button type="button" data-pf-pick="${esc(s.symbol)}"><b>${esc(s.symbol)}</b> ${esc(s.name)} <small>${esc(s.nameEn || '')}</small></button></li>`).join('') || '<li class="pf-empty">لا نتائج</li>';
    }
    const keepInputs = () => { const l = box.querySelector('[data-pf-limit]'); if (l) state.limit = l.value; };

    root.addEventListener('click', async e => {
      if (e.target === root || e.target.closest('[data-pf-close]')) return closeTicket();
      const pick = e.target.closest('[data-pf-pick]'); if (pick) { state.symbol = pick.dataset.pfPick; state.quote = null; return render(); }
      const sideBtn = e.target.closest('[data-pf-side]'); if (sideBtn) { keepInputs(); state.side = sideBtn.dataset.pfSide; state.limit = ''; return render(); }
      const typeBtn = e.target.closest('[data-pf-type]'); if (typeBtn) { keepInputs(); state.type = typeBtn.dataset.pfType; if (state.type === 'limit' && !state.limit && state.price) state.limit = String(state.price); return render(); }
      const modeBtn = e.target.closest('[data-pf-mode]'); if (modeBtn) { keepInputs(); state.mode = modeBtn.dataset.pfMode; return render(); }
      const lp = e.target.closest('[data-pf-lp]');
      if (lp && state.price) { const v = Math.round(state.price * (1 + Number(lp.dataset.pfLp) / 100) * 100) / 100; box.querySelector('[data-pf-limit]').value = String(v); keepInputs(); return paintEstimate(); }
      const pct = e.target.closest('[data-pf-pct]'); if (pct) return fillPct(Number(pct.dataset.pfPct));
      const cancel = e.target.closest('[data-pf-cancel]'); if (cancel) { cancelOrder(cancel.dataset.pfCancel); return render('<span class="pf-ok">أُلغي الأمر وأُفرج عن المحجوز.</span>'); }
      if (e.target.closest('[data-pf-confirm]') && !state.busy) {
        keepInputs();
        state.busy = true; paintEstimate();
        const v = inputValue(), amt = state.mode === 'qty' ? { qty: v } : { amount: v };
        const r = state.type === 'limit' ? await placeOrder({ side: state.side, symbol: state.symbol, limit: Number(state.limit), ...amt }) : await execute({ side: state.side, symbol: state.symbol, ...amt });
        state.busy = false;
        if (!dialog) return;
        if (!r.ok) { render(); box.querySelector('[data-pf-msg]').innerHTML = `<span class="pf-err">${esc(r.error)}</span>`; return; }
        if (r.pending) { const o = r.order; render(`<span class="pf-ok">✓ وُضع أمر ${o.side === 'buy' ? 'شراء' : 'بيع'} ${f4.format(o.qty)} من ${esc(o.symbol)} بحد ${f2.format(o.limit)}$ (معلّق). سيُنفَّذ تلقائيًا عند وصول السعر.</span>`); return; }
        const t = r.trade;
        render(`<span class="pf-ok">✓ ${r.immediate ? 'نُفّذ فورًا: ' : 'تم '}${t.side === 'buy' ? 'شراء' : 'بيع'} ${f4.format(t.qty)} من ${esc(t.symbol)} بسعر ${f2.format(t.price)}$ (الإجمالي ${f2.format(t.total)}$).</span>`);
      }
    });
    root.addEventListener('input', e => { if (e.target.matches('[data-pf-input],[data-pf-limit]')) { keepInputs(); paintEstimate(); } if (e.target.matches('[data-pf-search]')) searchResults(e.target.value); });
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

  window.Portfolio = { KEY, START_CASH, load, save, fresh, replay, execute, placeOrder, cancelOrder, openOrders, availability, processOrders, backfill, lastPrice, equityNow, stockInfo, snapshot, canTrade, holding, openTicket, closeTicket, etDate, ensureStyle, toast, startWatcher };

  // أزرار «data-pf-trade="buy|sell"» في أي صفحة تفتح نافذة الأمر (data-pf-symbol أو الرمز من الصفحة)
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-pf-trade]');
    if (!b) return;
    e.preventDefault();
    openTicket(b.dataset.pfSymbol || null, b.dataset.pfTrade === 'sell' ? 'sell' : 'buy');
  });

  // عند وجود أوامر معلّقة يبدأ المراقب في أي صفحة تحمّل هذا الملف
  const boot = () => { if (openOrders(load()).length) startWatcher(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
