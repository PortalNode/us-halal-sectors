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

  async function get(path, ms = 8000) {
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

  // رموز كثيرة: دفعات من 40 بالتوازي. يعيد Map(رمز → عرض سعر)
  async function quotes(symbols) {
    const list = [...new Set(symbols.filter(Boolean))], out = new Map();
    const chunks = [];
    for (let i = 0; i < list.length; i += 40) chunks.push(list.slice(i, i + 40));
    const results = await Promise.all(chunks.map(c => get(`/quotes?symbols=${encodeURIComponent(c.join(','))}`)));
    for (const r of results) for (const [symbol, quote] of Object.entries(r?.quotes || {})) if (quote?.price > 0) out.set(symbol, quote);
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
  const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  // "Nov 20, 2026 11:02 AM ET" → "2026-11-20"
  const dateOf = quote => { const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/.exec(quote?.time || ''); return m ? `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}` : null; };

  window.LiveQuotes = {
    enabled: !!url, url, quotes, session, isExtendedHours, dateOf,
    get status() { return { ...state }; },
    onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();
