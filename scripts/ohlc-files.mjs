// قراءة شموع سهم من ملفين: ohlc/<الرمز>.json (الجلسات الحديثة) و ohlc/history/<الرمز>.json (ما قبلها).
// يعيد ملفاً واحداً كاملاً { symbol, d, o, h, l, c, v, est, flags, ... } أو null.
import { readFile } from 'node:fs/promises';

const readJson = async url => { try { return JSON.parse(await readFile(url, 'utf8')); } catch { return null; } };
const COLUMNS = ['d', 'o', 'h', 'l', 'c', 'v'];

/** الملف الحديث وملف تاريخه (أو null) → ملف شموع واحد. الجلسات المكررة بين الملفين تؤخذ من الحديث. */
export function joinFiles(recent, history) {
  if (!history || !recent.historyThrough) return recent;
  const keep = history.d.map(d => d < recent.d[0]);
  const full = { ...recent, est: [...(history.est || []), ...(recent.est || [])], flags: [...(history.flags || []), ...(recent.flags || [])] };
  for (const key of COLUMNS) full[key] = [...history[key].filter((_, i) => keep[i]), ...recent[key]];
  delete full.historyThrough;
  return full;
}

/** شموع `symbol` الكاملة من المجلد `dir` (URL ينتهي بـ /)، أو null إن لم توجد. */
export async function readCandles(dir, symbol) {
  const recent = await readJson(new URL(`${symbol}.json`, dir));
  if (!recent) return null;
  return recent.historyThrough ? joinFiles(recent, await readJson(new URL(`history/${symbol}.json`, dir))) : recent;
}
