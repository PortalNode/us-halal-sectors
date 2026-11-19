// «مفاتيح جودة السهم» للسوق الأمريكي الشرعي: يحسب المفاتيح الستة لكل سهم مرة لكل جلسة ويكتب scanner/signals.json.
// يعمل بعد تحديث ohlc/ و data.json و financials.json:   node scripts/build-scanner.mjs
//
// قواعد يفرضها هذا الملف (الصفحة لا تحسب شيئاً بنفسها):
//  * لا نتيجة لسهم إلا إذا كانت آخر شمعة له هي أحدث شمعة في السوق كله (تاريخ الحساب dataDate)
//  * إذا كان تاريخ الإغلاق المنشور في data.json هو نفسه dataDate يُتحقق من سعر كل سهم (فرق أقل من 0.5% عن إغلاق الشمعة)؛
//    وإذا كان data.json أحدث من الشموع (الشموع متأخرة جلسة) تُحسب المفاتيح على إغلاق الشموع ويُوسَم ذلك في meta.lagging
//    فتعرضه الصفحة بوضوح، ولا تُخلط أسعار data.json بالشموع
//  * الموقوف والقديم وغير المتحقق منه والقصير التاريخ وضعيف جودة البيانات وسيولته دون 10 ملايين دولار يومياً
//    يُسجَّل سببه في meta.excluded ولا تُحسب له مفاتيح
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readCandles } from './ohlc-files.mjs';
import { sma, atr as atrSeries } from '../scanner/indicators.mjs';
import { nearestZones } from './sr-levels.mjs';
import { KEY_IDS, KEY_LABELS, MIN_SCORE, DIVIDEND_MIN, computeKeys, financialKey, marketKey, loadFinancials } from './quality-keys.mjs';

const ROOT = new URL('../', import.meta.url);
const OUT = new URL('scanner/signals.json', ROOT);
const OHLC_DIR = new URL('ohlc/', ROOT);
const INDEX_SYMBOL = 'SPUS';          // المؤشر المرجعي للموقع (مفتاح السوق)
const WARMUP = 250;                   // جلسات لازمة قبل الحكم (متوسط 200 مع هامش)
const MIN_AVG_VALUE = 1e7;            // متوسط قيمة التداول 20 جلسة (دولار)
const r = (x, d = 2) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;

const data = JSON.parse(readFileSync(new URL('data.json', ROOT), 'utf8'));
const official = new Map(), sectorOf = new Map();
for (const sec of data.sectors) for (const s of sec.stocks) { official.set(s.symbol, s); sectorOf.set(s.symbol, sec.name); }

const stocks = [];
for (const symbol of official.keys()) {
  const f = await readCandles(OHLC_DIR, symbol);
  if (!f || f.d.length < 2) continue;
  const est = new Set(f.est || []), flags = new Set((f.flags || []).map(x => x.date));
  stocks.push({ symbol, d: f.d, h: f.h, l: f.l, c: f.c, v: f.v, est: f.d.map(x => est.has(x)), flag: f.d.map(x => flags.has(x)), val: f.d.map((_, i) => f.c[i] * f.v[i]) });
}

const newest = stocks.map(s => s.d.at(-1)).sort().at(-1);
const publishedDate = data.priceSource?.officialDate || null;
const meta = { valid: true, dataDate: newest, officialDate: publishedDate, lagging: !!publishedDate && publishedDate > newest, generatedAt: new Date().toISOString(), universe: official.size, scanned: 0, minScore: MIN_SCORE, dividendMin: DIVIDEND_MIN, minAvgValue: MIN_AVG_VALUE, excluded: {}, reasonInvalid: null };
const keys = Object.fromEntries(KEY_IDS.map(id => [id, KEY_LABELS[id]]));

const publish = payload => {
  // لا commit في كل تشغيل إن لم يتغير شيء سوى الساعة
  if (existsSync(OUT)) { try { const old = JSON.parse(readFileSync(OUT, 'utf8')); const strip = ({ meta: m, ...rest }) => JSON.stringify({ ...rest, meta: { ...m, generatedAt: 0 } }); if (strip(old) === strip(payload)) { console.log('scanner: unchanged'); return; } } catch { /* rewrite */ } }
  writeFileSync(OUT, JSON.stringify(payload) + '\n');
  console.log(`scanner: wrote ${Object.keys(payload.stocks).length} stocks (${newest}${meta.lagging ? `, الشموع متأخرة عن ${publishedDate}` : ''})`);
};

if (!newest || (publishedDate && newest > publishedDate)) {
  meta.valid = false; meta.reasonInvalid = !newest ? 'لا توجد شموع' : `أحدث شمعة ${newest} أحدث من تاريخ الإغلاق المنشور ${publishedDate}`;
  publish({ meta, keys, stocks: {} });
  process.exit(0);
}

const indexFile = await readCandles(OHLC_DIR, INDEX_SYMBOL);
const market = marketKey(indexFile?.c);
meta.market = { symbol: INDEX_SYMBOL, trend: market.trend, date: indexFile?.d?.at(-1) ?? null, stale: indexFile?.d?.at(-1) !== newest, detail: market.detail };
const financials = loadFinancials(new URL('financials.json', ROOT));

const skip = (reason, symbol) => (meta.excluded[reason] ||= []).push(symbol);
const outStocks = {};
const count = (flags, from) => { let n = 0; for (let k = from; k < flags.length; k++) if (flags[k]) n++; return n; };

for (const s of stocks) {
  const i = s.d.length - 1, o = official.get(s.symbol);
  if (o?.suspended) { skip('suspended', s.symbol); continue; }
  if (s.d[i] !== newest) { skip('stale', s.symbol); continue; }
  // تحقق السعر ممكن فقط حين يكون تاريخ data.json هو تاريخ الشموع نفسه
  if (!meta.lagging && (o?.priceStatus !== 'close' || o.priceDate !== newest || !(o.price > 0) || Math.abs(o.price / s.c[i] - 1) > 0.005)) { skip('unverified', s.symbol); continue; }
  if (i < WARMUP) { skip('shortHistory', s.symbol); continue; }
  if (s.est[i] || s.flag[i] || count(s.flag, i - 19) > 0 || count(s.est, i - 19) > 3) { skip('dataQuality', s.symbol); continue; }
  const avgVal20 = sma(s.val, 20)[i];
  if (!(avgVal20 >= MIN_AVG_VALUE)) { skip('illiquid', s.symbol); continue; }
  meta.scanned += 1;

  const c = s.c[i];
  const sma50 = sma(s.c, 50)[i], sma200 = sma(s.c, 200)[i];
  const { support, resistance, atr } = nearestZones(s.h, s.l, s.c, i, undefined, atrSeries(s.h, s.l, s.c, 14), s.d);
  const avgVol20Prev = sma(s.v, 20)[i - 1], volRatio = avgVol20Prev > 0 ? s.v[i] / avgVol20Prev : null;

  const k = computeKeys({ close: s.c, i, support, resistance, atr, financial: financialKey(financials.get(s.symbol)), market, dividendYield: o.dividendYield });
  outStocks[s.symbol] = {
    name: o.name, nameEn: o.nameEn ?? null, sector: sectorOf.get(s.symbol), price: r(c), tradedValue: r(c * s.v[i], 0), avgVal20: r(avgVal20, 0), volRatio: r(volRatio),
    score: k.score, bits: k.bits, trend: k.trend, dividendYield: r(o.dividendYield), dividendOk: k.dividendOk,
    support: r(support?.center), resistance: r(resistance?.center), supportZone: support ? [r(support.low), r(support.high), support.touches, s.d[support.first]] : null, resistanceZone: resistance ? [r(resistance.low), r(resistance.high), resistance.touches, s.d[resistance.first]] : null, atr: r(atr), sma50: r(sma50), sma200: r(sma200),
    keys: Object.fromEntries(KEY_IDS.map(id => [id, [k.keys[id].ok, k.keys[id].detail]])),
  };
}

const scores = Object.values(outStocks).map(x => x.score);
meta.counts = { six: scores.filter(x => x === 6).length, five: scores.filter(x => x === 5).length };
publish({ meta, keys, stocks: outStocks });
