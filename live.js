// أسعار لحظية من وسيط Cloudflare Worker (worker/live-worker.js) الذي يقرأ Nasdaq Last Sale.
// window.LiveQuotes: { enabled, quotes(symbols), session(symbol), isExtendedHours(), dateOf(quote), onStatus }
(() => {
  const KEY = 'us-halal-live-url';
  let url = '';
  try {
    const q = new URLSearchParams(location.search).get('live');
    if (q !== null) { if (q === '' || q === 'off') localStorage.removeItem(KEY); else localStorage.setItem(KEY, q); }
    url = localStorage.getItem(KEY) || '';
  } catch { /* storage unavailable */ }
  url = (url || window.LIVE_CONFIG?.workerUrl || '').replace(/\/+$/, '');

  const listeners = new Set();
  const state = { ok: null, at: 0, error: '' };
  const report = (ok, error = '') => {
    if (state.ok === ok && !error && state.ok !== false) { state.at = Date.now(); return; }
    Object.assign(state, { ok, at: Date.now(), error });
    for (const fn of listeners) try { fn({ ...state }); } catch { /* ignore */ }
  };

  async function get(path, ms = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await fetch(`${url}${path}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      report(true);
      return body;
    } catch (error) {
      report(false, error.name === 'AbortError' ? 'انتهت مهلة الاتصال' : String(error.message || error));
      return null;
    } finally { clearTimeout(timer); }
  }

  // ناسداك خارج الجلسة العادية (ما قبل السوق وما بعده وبعد الإغلاق) يعيد سعر آخر صفقة ممتدة،
  // ونسبة تغيرها محسوبة من إغلاق اليوم لا من إغلاق الجلسة السابقة (مثال: NVDA ‎+0.25% بدل ‎+31.48%)،
  // وحقل previousClosePrice عنده قديم. لذلك لا يُقبل من ناسداك إلا أسعار الجلسة العادية (Open)،
  // ويُكمَل الباقي من TradingView: إغلاق الجلسة العادية وتغيره عن إغلاق الجلسة السابقة.
  const regular = quote => quote?.status === 'Open' && quote.price > 0;
  const withPct = quote => Number.isFinite(quote.pct) || !Number.isFinite(quote.change) || !(quote.price - quote.change > 0)
    ? quote : { ...quote, pct: quote.change / (quote.price - quote.change) * 100 };

  // رموز كثيرة: دفعات من 100. يعيد Map(رمز → عرض سعر)
  async function quotes(symbols) {
    const list = [...new Set(symbols.filter(Boolean))], out = new Map();
    const chunks = [];
    for (let i = 0; i < list.length; i += 100) chunks.push(list.slice(i, i + 100));
    const results = await Promise.all(chunks.map(c => get(`/quotes?symbols=${encodeURIComponent(c.join(','))}`)));
    for (const r of results) for (const [symbol, raw] of Object.entries(r?.quotes || {})) {
      if (!regular(raw)) continue;
      const quote = withPct(raw);
      if (Number.isFinite(quote.pct)) out.set(symbol, quote);
    }
    const missing = list.filter(symbol => !out.has(symbol));
    if (missing.length) for (const [symbol, quote] of await tradingView(missing)) out.set(symbol, quote);
    return out;
  }

  // إغلاق الجلسة العادية من TradingView (أو سعرها المتأخر 15 دقيقة أثناء الجلسة إن تعذر ناسداك)
  const TV_SCAN = 'https://scanner.tradingview.com/america/scan', TV_TTL = 60e3;
  const TV_COLUMNS = ['name', 'close', 'change', 'change_abs', 'time', 'volume', 'currency'];
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
  let tvMemo = { t: 0, key: '', value: new Map() };
  const tvPost = body => fetch(TV_SCAN, {
    method: 'POST', mode: 'cors', cache: 'no-store',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', Accept: 'application/json' }, body: JSON.stringify(body)
  }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  function tvQuote(row) {
    const [, close, pct, change, time, volume, currency] = row || [];
    if (!(close > 0) || !Number.isFinite(pct) || !Number.isFinite(time) || (currency && currency !== 'USD')) return null;
    const bar = new Date(time * 1000), status = isRegularHours() && ymd.format(bar) === ymd.format(new Date()) ? 'Delayed' : 'Closed';
    return {
      price: close, pct, change: Number.isFinite(change) ? change : null, volume: Number.isFinite(volume) ? volume : null,
      time: `${dayLabel.format(bar)} ${status === 'Closed' ? '4:00 PM ET' : 'ET (15 min delayed)'}`,
      realtime: false, status, source: 'TradingView'
    };
  }
  async function tradingView(symbols) {
    const names = new Map(symbols.map(symbol => [symbol.split(':')[0].toUpperCase(), symbol]));
    const key = [...names.keys()].sort().join(',');
    if (tvMemo.key === key && Date.now() - tvMemo.t < TV_TTL) return tvMemo.value;
    const [rows, index] = await Promise.all([
      tvPost({ filter: [{ left: 'name', operation: 'in_range', right: [...names.keys()] }, { left: 'is_primary', operation: 'equal', right: true }],
        columns: TV_COLUMNS, range: [0, names.size + 50] }),
      // مؤشر S&P 500 نفسه بدل تقديره من SPY
      names.has('SPY') ? tvPost({ symbols: { tickers: ['SP:SPX'], query: { types: [] } }, columns: TV_COLUMNS }) : null
    ]);
    const out = new Map();
    for (const row of rows?.data || []) {
      const symbol = names.get(String(row.d?.[0] || '').toUpperCase()), quote = symbol && !out.has(symbol) && tvQuote(row.d);
      if (quote) out.set(symbol, quote);
    }
    const spx = tvQuote(index?.data?.[0]?.d);
    if (spx) out.set('SPX', { ...spx, index: true });
    if (out.size) tvMemo = { t: Date.now(), key, value: out };
    return out;
  }
  const session = symbol => get(`/session?symbol=${encodeURIComponent(symbol)}`);

  const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  // ما قبل السوق وبعده تُسعَّر لحظيًا أيضًا: 4:00 – 20:00 بتوقيت نيويورك، الاثنين–الجمعة
  function isExtendedHours(now = new Date()) {
    const p = Object.fromEntries(NY.formatToParts(now).map(x => [x.type, x.value]));
    const m = +p.hour * 60 + +p.minute;
    return !['Sat', 'Sun'].includes(p.weekday) && m >= 240 && m < 1200;
  }
  // الجلسة العادية: 9:30 – 16:00 بتوقيت نيويورك
  function isRegularHours(now = new Date()) {
    const p = Object.fromEntries(NY.formatToParts(now).map(x => [x.type, x.value]));
    const m = +p.hour * 60 + +p.minute;
    return !['Sat', 'Sun'].includes(p.weekday) && m >= 570 && m < 960;
  }
  const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  // "Nov 20, 2026 11:02 AM ET" → "2026-11-20"
  const dateOf = quote => { const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/.exec(quote?.time || ''); return m ? `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}` : null; };

  // آخر أسعار لحظية محفوظة في المتصفح: تُعرض فور فتح الصفحة بدل لقطة data.json القديمة، ثم يحدّثها أول رد حي.
  const CACHE_KEY = 'us-halal-live-cache';
  const saveCache = quotes => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), quotes: Object.fromEntries(quotes) })); } catch { /* storage full/unavailable */ }
  };
  // newerThan: وقت (ms) — لا تُستخدم الأسعار المحفوظة إلا إن كانت أحدث منه (أحدث من لقطة data.json)
  const loadCache = (newerThan = 0) => {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      // تُهمل أسعار ما قبل السوق وما بعده المحفوظة من نسخ سابقة (نسبتها محسوبة من إغلاق اليوم لا الأمس)
      if (c?.quotes && c.t > newerThan && Date.now() - c.t < 18 * 3600e3)
        return new Map(Object.entries(c.quotes).filter(([, q]) => q?.source === 'TradingView' || regular(q)));
    } catch { /* ignore */ }
    return new Map();
  };

  window.LiveQuotes = {
    saveCache, loadCache,
    enabled: !!url, url, quotes, session, isExtendedHours, isRegularHours, dateOf,
    get status() { return { ...state }; },
    onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();
