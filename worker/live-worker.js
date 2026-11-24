// وسيط الأسعار اللحظية (Cloudflare Worker): يقرأ أسعار Nasdaq الحية ويضيف CORS ليقرأها المتصفح.
//
//   GET /quotes?symbols=AAPL,MSFT,...   (حتى 100 رمز في الطلب؛ SYMBOL:etf لصناديق غير معروفة)
//       → { asOf, quotes: { AAPL: { price, change, pct, volume, time, status, realtime, prevClose, open } } }
//   GET /session?symbol=AAPL
//       → { symbol, date, open, high, low, close, volume, prevClose, status, ticks: [[wallMs, price], ...] }
//          (شمعة جلسة اليوم من بيانات الصفقات اللحظية، لتحريك آخر شمعة في الشارت)
//
// الأسعار «Nasdaq Last Sale»: صفقات لحظية لكنها من منصات ناسداك فقط، فقد تختلف قليلًا عن السعر المجمّع.
// لا يحتاج مفتاح API. للنشر: انظر worker/README.md
const NQ = 'https://api.nasdaq.com/api/quote/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/'
};
const MAX_SYMBOLS = 100;          // 100 رمز = 5 طلبات خارجية فقط (الحد المجاني 50 لكل استدعاء)
const TTL = 1500;                 // ملّي ثانية: لا نكرر الطلب نفسه إلى ناسداك خلال هذه المدة
const cache = new Map();

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=1' }
});

const money = s => { const n = parseFloat(String(s ?? '').replace(/[$,%+\s]/g, '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const SYMBOL = /^[A-Z][A-Z0-9.\-]{0,9}$/;

async function nasdaq(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const promise = fetch(NQ + path, { headers: HEADERS, cf: { cacheTtl: 1 } }).then(async r => {
    if (!r.ok) throw new Error(`nasdaq ${r.status}`);
    const body = await r.json();
    if (!body?.data) throw new Error('nasdaq empty');
    return body.data;
  });
  cache.set(path, { t: Date.now(), v: promise });
  promise.catch(() => cache.delete(path));
  if (cache.size > 800) for (const k of cache.keys()) { cache.delete(k); if (cache.size < 400) break; }
  return promise;
}

// أسهم ثم صناديق (ETF) كحال SPUS
async function info(symbol) {
  for (const cls of ['stocks', 'etf']) {
    try {
      const d = await nasdaq(`${symbol}/info?assetclass=${cls}`);
      if (d.primaryData?.lastSalePrice) return d;
    } catch { /* جرّب الفئة التالية */ }
  }
  return null;
}

function quoteOf(d) {
  const p = d.primaryData, range = String(d.keyStats?.dayrange?.value || '').split('-').map(money);
  return {
    price: money(p.lastSalePrice), change: money(p.netChange), pct: money(p.percentageChange),
    volume: money(p.volume), time: p.lastTradeTimestamp || null, realtime: p.isRealTime === true,
    status: d.marketStatus || null, bid: money(p.bidPrice), ask: money(p.askPrice),
    low: range[0] ?? null, high: range[1] ?? null
  };
}

// ختم الوقت x في صفقات ناسداك هو توقيت نيويورك «الجداري» مكتوب كأنه UTC (4:00 AM ET → 04:00Z)،
// فنقرأ حقوله بـ UTC مباشرة دون تحويل منطقة زمنية.
const wall = ms => { const iso = new Date(ms).toISOString(); return { date: iso.slice(0, 10), minutes: +iso.slice(11, 13) * 60 + +iso.slice(14, 16) }; };

// "Nov 20, 2026 4:00 PM ET" → "2026-11-20" (null إن لم يُفهم)
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const quoteDay = time => { const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/.exec(time || ''); return m && MONTHS[m[1]] ? `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}` : null; };

// صناديق (ETF) لا تُجلب كأسهم: هذه الرموز تُرسل بفئة etf (ويمكن للعميل كتابة SYMBOL:etf صراحة)
const ETFS = new Set(['SPY', 'SPUS', 'QQQ', 'VOO', 'IVV', 'DIA', 'IWM', 'HLAL', 'UMMA']);
const STATUS = s => /pre/i.test(s) ? 'Pre-Market' : /after|post/i.test(s) ? 'After-Hours' : /closed/i.test(s) ? 'Closed' : /open/i.test(s) ? 'Open' : s || null;

// واجهة watchlist عند ناسداك تعيد حتى 20 رمزًا في طلب واحد (أسرع بكثير من طلب لكل رمز)
async function watchlist(chunk) {
  const query = chunk.map(([symbol, cls]) => `symbol=${encodeURIComponent(`${symbol.toLowerCase()}|${cls}`)}`).join('&');
  const rows = await nasdaq(`watchlist?${query}`);
  return Array.isArray(rows) ? rows : [];
}

async function quotes(url) {
  const raw = [...new Set((url.searchParams.get('symbols') || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean))];
  if (!raw.length) return json({ error: 'symbols required' }, 400);
  const list = raw.map(item => { const [symbol, cls] = item.split(':'); return [symbol, cls === 'ETF' || ETFS.has(symbol) ? 'etf' : 'stocks']; });
  if (list.length > MAX_SYMBOLS || list.some(([s]) => !SYMBOL.test(s))) return json({ error: `1-${MAX_SYMBOLS} valid symbols` }, 400);
  const chunks = [];
  for (let i = 0; i < list.length; i += 20) chunks.push(list.slice(i, i + 20));
  const out = {};
  await Promise.all(chunks.map(async chunk => {
    let rows = [];
    try { rows = await watchlist(chunk); } catch { /* هذه الدفعة فقط */ }
    for (const r of rows) {
      const price = money(r.lastSalePrice);
      if (!(price > 0)) continue;
      out[String(r.symbol).toUpperCase()] = {
        price, change: money(r.netChange), pct: money(r.percentageChange), volume: money(r.volume),
        time: r.lastTradeTimestamp || null, realtime: true, status: STATUS(r.marketStatus),
        prevClose: Number.isFinite(r.previousClosePrice) ? r.previousClosePrice : money(r.previousClosePrice),
        open: Number.isFinite(r.openingPrice) ? r.openingPrice : money(r.openingPrice)
      };
    }
  }));
  return json({ asOf: Date.now(), quotes: out });
}

async function session(url) {
  const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
  if (!SYMBOL.test(symbol)) return json({ error: 'valid symbol required' }, 400);
  // السعر والصفقات بالتوازي (نصف الزمن): الفئة تُخمَّن من الرمز ثم تُصحَّح إن لزم
  const guess = ETFS.has(symbol) ? 'etf' : 'stocks';
  const [d, chart] = await Promise.all([info(symbol), nasdaq(`${symbol}/chart?assetclass=${guess}`).catch(() => null)]);
  if (!d) return json({ error: 'not found' }, 404);
  const q = quoteOf(d), cls = d.assetClass === 'ETF' ? 'etf' : 'stocks';
  let ticks = [], prevClose = null;
  try {
    const c = chart && cls === guess ? chart : await nasdaq(`${symbol}/chart?assetclass=${cls}`);
    ticks = (c.chart || []).map(t => [t.x, t.y]).filter(t => Number.isFinite(t[0]) && Number.isFinite(t[1]));
    prevClose = money(c.previousClose);
  } catch { /* نكتفي بسعر info */ }
  const date = wall(ticks.at(-1)?.[0] ?? Date.now()).date;
  // الجلسة العادية فقط: 9:30 – 16:00 بتوقيت نيويورك
  const regular = ticks.filter(([ms]) => { const w = wall(ms); return w.date === date && w.minutes >= 570 && w.minutes <= 960; });
  const px = regular.map(t => t[1]);
  // صفحة info عند ناسداك تتأخر أحيانًا يومًا عن الصفقات (إغلاق الجلسة السابقة وحجمها ونطاقها):
  // إن اختلف يومها عن يوم الصفقات فلا يُؤخذ منها شيء، ويكون الإغلاق آخر صفقة في الجلسة
  const sameDay = !q.time || quoteDay(q.time) === date;
  const high = Math.max(...px, sameDay ? q.high ?? -Infinity : -Infinity), low = Math.min(...px, sameDay ? q.low ?? Infinity : Infinity);
  return json({
    symbol, date, open: px[0] ?? null, high: Number.isFinite(high) ? high : null, low: Number.isFinite(low) ? low : null,
    close: sameDay ? q.price : px.at(-1) ?? null, volume: sameDay ? q.volume : null, prevClose, status: q.status,
    time: sameDay ? q.time : null, realtime: q.realtime, ticks
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/quotes') return await quotes(url);
      if (url.pathname === '/session') return await session(url);
      if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'us-halal-live', endpoints: ['/quotes?symbols=', '/session?symbol='] });
      return json({ error: 'not found' }, 404);
    } catch (error) {
      return json({ error: String(error?.message || error) }, 502);
    }
  }
};
