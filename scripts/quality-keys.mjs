// «مفاتيح جودة السهم»: ستة مفاتيح، كل مفتاح 1 (إيجابي) أو 0. السهم يظهر في الماسح إذا بلغ مجموعه 5 أو 6.
// دوال نقية بلا I/O (عدا loadFinancials) حتى تُختبر بأرقام صغيرة. غياب بيانات مفتاح = 0 مع بيان السبب، ولا يُخمَّن.
import { readFileSync } from 'node:fs';
import { sma, macd } from '../scanner/indicators.mjs';

export const KEY_IDS = ['trend', 'fin', 'market', 'levels', 'sma55', 'macd'];
export const KEY_LABELS = { trend: 'اتجاه السهم', fin: 'التحليل المالي', market: 'جودة السوق S&P 500', levels: 'مستويات الأسعار', sma55: 'المتوسط 55 يوم', macd: 'مؤشر MACD' };
export const MIN_SCORE = 5;
export const DIVIDEND_MIN = 2.5; // نسبة التوزيعات المفضلة (%): وسم فقط ولا تدخل في العدّ

const fin = x => x != null && Number.isFinite(x);
const f2 = (x, d = 2) => fin(x) ? x.toFixed(d) : '—';
const key = (ok, detail) => ({ ok: ok ? 1 : 0, detail });

// صاعد: الإغلاق فوق متوسط 50 وهو فوق متوسط 200 ومتوسط 50 صاعد (20 جلسة). هابط: العكس. وإلا عرضي.
export function trendAt(close, i) {
  const s50 = sma(close, 50), s200 = sma(close, 200);
  const a = s50[i], b = s200[i], p = i >= 20 ? s50[i - 20] : null;
  if (![a, b, p].every(fin) || !p) return { trend: 'na', sma50: a, sma200: b };
  const up = close[i] > a && a > b && a / p - 1 > 0, down = close[i] < a && a < b;
  return { trend: up ? 'up' : down ? 'down' : 'side', sma50: a, sma200: b };
}

// مفتاح السوق: اتجاه المؤشر المرجعي للموقع (مؤشر S&P 500، شموعه في ohlc/SPX.json) بنفس تعريف
// مفتاح السهم، قيمة واحدة لكل الأسهم.
export function marketKey(indexClose) {
  if (!indexClose || indexClose.length < 221) return { ...key(false, 'شموع S&P 500 غير كافية'), trend: 'na' };
  const { trend } = trendAt(indexClose, indexClose.length - 1);
  return { ...key(trend === 'up', trend === 'up' ? 'مؤشر S&P 500 في اتجاه صاعد' : trend === 'down' ? 'مؤشر S&P 500 في اتجاه هابط' : 'مؤشر S&P 500 عرضي / غير واضح'), trend };
}

// [قديمة، تبقى كمرجع في scripts/backtest/sr-eval.mjs؛ الماسح يستعمل sr-levels.mjs] دعم ومقاومة من قمم وقيعان الحركة السعرية (لا من المتوسطات): قاع/قمة محورية = أدنى/أعلى سعر بين k شموع قبلها وk بعدها،
// ومعها أدنى/أعلى سعر للجلسات السابقة (20 و60، و120 و252 للقمم) دون جلسة اليوم، فالإغلاق عند قمة جديدة لا مقاومة فوقه. الدعم = أعلى قاع تحت السعر، والمقاومة = أدنى قمة فوقه.
export function swingLevels(high, low, close, i, { k = 4, lookback = 252 } = {}) {
  const price = close[i], from = Math.max(0, i - lookback), lows = [], highs = [];
  for (let j = Math.max(k, from); j <= i - k; j++) {
    let isLow = true, isHigh = true;
    for (let m = j - k; m <= j + k; m++) { if (low[m] < low[j]) isLow = false; if (high[m] > high[j]) isHigh = false; }
    if (isLow) lows.push(low[j]);
    if (isHigh) highs.push(high[j]);
  }
  for (const n of [20, 60]) lows.push(Math.min(...low.slice(Math.max(0, i - n), i)));
  for (const n of [20, 60, 120, 252]) highs.push(Math.max(...high.slice(Math.max(0, i - n), i)));
  const below = lows.filter(x => x < price), above = highs.filter(x => x > price);
  return { support: below.length ? Math.max(...below) : null, resistance: above.length ? Math.min(...above) : null };
}

// منطقة دعم/مقاومة كما تخرج من sr-levels.mjs: { low, high, center, touches }. المسافة بوحدة ATR من حافة المنطقة (صفر داخلها).
const zoneText = (z, label) => `${label} ${f2(z.low)}–${f2(z.high)} (${z.touches} لمسات)`;
export const AT_SUPPORT_ATR = 1.0; // «عند الدعم»: داخل المنطقة أو فوق حافتها العليا بأقل من 1×ATR
// 1+ إذا كان السهم عند منطقة دعم (داخلها أو ضمن 1×ATR فوقها) وأقرب إليها من أقرب منطقة مقاومة. 0 إذا كان أقرب للمقاومة
// أو بعيداً عن أي دعم أو لا دعم تحته. لا مقاومة فوقه (قمة جديدة) تعني أن المسافة إليها لا نهائية فيُحكم بالقرب من الدعم وحده.
export function levelsKey(price, support, resistance, atr) {
  if (!fin(price) || !(atr > 0)) return key(false, 'لا بيانات كافية لتحديد المستويات');
  if (!support) return key(false, resistance ? `لا توجد منطقة دعم مؤكدة تحت السعر · ${zoneText(resistance, 'مقاومة')}` : 'لا توجد مناطق دعم أو مقاومة مؤكدة');
  const dS = Math.max(0, price - support.high) / atr, dR = resistance ? Math.max(0, resistance.low - price) / atr : Infinity;
  const detail = `${zoneText(support, 'دعم')} يبعد ${f2(dS, 1)}×ATR${resistance ? ` · ${zoneText(resistance, 'مقاومة')} تبعد ${f2(dR, 1)}×ATR` : ' · لا مقاومة فوق السعر'}`;
  return key(dS <= AT_SUPPORT_ATR && dS < dR, detail);
}

export function sma55Key(close, i) {
  const m = sma(close, 55)[i];
  return fin(m) ? key(close[i] > m, `الإغلاق ${f2(close[i])} · متوسط 55: ${f2(m)}`) : key(false, 'تاريخ أقصر من 55 جلسة');
}

export function macdKey(close, i) {
  const m = macd(close)[i];
  return m && fin(m.signal) ? key(m.macd > m.signal, `MACD ${f2(m.macd, 3)} · الإشارة ${f2(m.signal, 3)}`) : key(false, 'بيانات MACD غير كافية');
}

/* ---------- التحليل المالي ---------- */
// financials.json (TradingView): companies[symbol].quarterly = { labels: ['2026-Q3', '2026-Q2', ...] (الأحدث أولاً), netIncome: [...] }
// بالدولار؛ و annual = { years: [...], netIncome: [...] }. الوحدة في النص بالمليون دولار.
const qIndex = label => { const m = /^(\d{4})-Q([1-4])$/.exec(String(label)); return m ? +m[1] * 4 + +m[2] - 1 : null; };
const musd = x => (x / 1e6).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// نتيجة المفتاح لسهم من مجموع صافي ربح آخر 4 أرباع متتالية؛ وإن لم تتوفر فآخر سنة مالية؛ وإلا 0 مع السبب.
export function financialKey(co) {
  const q = co?.quarterly;
  const have = (q?.labels || []).map((label, k) => [qIndex(label), label, q.netIncome?.[k]]).filter(([i, , v]) => i != null && fin(v)).sort((a, b) => a[0] - b[0]);
  const last4 = have.slice(-4);
  if (last4.length === 4 && last4[3][0] - last4[0][0] === 3) {
    const sum = last4.reduce((s, x) => s + x[2], 0);
    return { ...key(sum > 0, `صافي ربح آخر 4 أرباع (${last4[0][1]} إلى ${last4[3][1]}): ${musd(sum)} مليون دولار`), basis: 'ttm', netProfit: sum };
  }
  const years = (co?.annual?.years || []).map((year, k) => ({ year, v: co.annual.netIncome?.[k] })).filter(y => fin(y.v)).sort((a, b) => a.year - b.year);
  const y = years.at(-1);
  if (y) return { ...key(y.v > 0, `صافي ربح سنة ${y.year}: ${musd(y.v)} مليون دولار (لا أرباع كافية)`), basis: 'fy', netProfit: y.v };
  return { ...key(false, 'لا تتوفر بيانات صافي الربح'), basis: 'none', netProfit: null };
}

// يقرأ financials.json إلى خريطة رمز → سجل الشركة
export function loadFinancials(url) {
  try { return new Map(Object.entries(JSON.parse(readFileSync(url, 'utf8')).companies || {})); } catch { return new Map(); }
}

/* ---------- التجميع ---------- */
// الأسهم 5/6 وما فوق تظهر. input: { close[], i, support, resistance, financial, market (نتيجة marketKey), dividendYield }
export function computeKeys({ close, i, support, resistance, atr, financial, market, dividendYield }) {
  const { trend, sma50, sma200 } = trendAt(close, i);
  const keys = {
    trend: key(trend === 'up', trend === 'up' ? 'الإغلاق فوق متوسط 50 وهو فوق متوسط 200 وصاعد' : trend === 'down' ? 'اتجاه هابط (الإغلاق تحت متوسط 50 وهو تحت 200)' : trend === 'side' ? 'اتجاه عرضي / غير واضح' : 'تاريخ أقصر من 200 جلسة'),
    fin: financial, market: { ok: market.ok, detail: market.detail },
    levels: levelsKey(close[i], support, resistance, atr), sma55: sma55Key(close, i), macd: macdKey(close, i),
  };
  const bits = KEY_IDS.map(id => keys[id].ok);
  return {
    trend, sma50, sma200, keys,
    score: bits.reduce((a, b) => a + b, 0),
    bits: bits.join(''),
    dividendOk: fin(dividendYield) && dividendYield > DIVIDEND_MIN,
  };
}
