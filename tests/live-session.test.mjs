import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionBar } from '../worker/live-worker.js';

// ختم صفقات ناسداك: توقيت نيويورك «الجداري» مكتوب كأنه UTC
const at = (hhmm, day = '2026-11-24') => Date.parse(`${day}T${hhmm}:00Z`);
// يوم NVDA في 24 نوفمبر 2026: ما قبل السوق، ثم الجلسة 150.60–159.80، ثم ما بعد السوق
const ticks = [
  [at('04:00'), 162.1], [at('09:29'), 158.99],
  [at('09:30'), 159.7999], [at('11:00'), 150.6001], [at('14:00'), 157.2], [at('15:59'), 155.4759], [at('16:00'), 154.96],
  [at('16:01'), 155.2032], [at('16:36'), 153.84]
];
// نطاق اليوم عند ناسداك ملوّث بصفقات شاذة
const polluted = { price: 153.84, volume: 381407884, time: 'Nov 24, 2026 4:37 PM ET', high: 230.26, low: 125 };

test('after the close: no polluted day range, close is the last regular-session trade', () => {
  const bar = sessionBar(ticks, { ...polluted, status: 'After-Hours' });
  assert.equal(bar.date, '2026-11-24');
  assert.equal(bar.open, 159.7999);
  assert.equal(bar.high, 159.7999);
  assert.equal(bar.low, 150.6001);
  assert.equal(bar.close, 154.96);
  assert.equal(bar.volume, null);
  assert.equal(bar.final, true);
});

test('during the session: an outlying day range is ignored, a close one is kept', () => {
  const open = ticks.slice(0, 5);
  const bad = sessionBar(open, { price: 157.3, volume: 2e8, time: 'Nov 24, 2026 2:01 PM ET', high: 230.26, low: 125, status: 'Open' });
  assert.equal(bad.high, 159.7999);
  assert.equal(bad.low, 150.6001);
  assert.equal(bad.close, 157.3);
  assert.equal(bad.final, false);
  const good = sessionBar(open, { price: 157.3, volume: 2e8, time: 'Nov 24, 2026 2:01 PM ET', high: 159.92, low: 150.5, status: 'Open' });
  assert.equal(good.high, 159.92);
  assert.equal(good.low, 150.5);
});

test('an outlying live price falls back to the last trade', () => {
  const bar = sessionBar(ticks.slice(0, 5), { price: 230.26, volume: 2e8, time: 'Nov 24, 2026 2:01 PM ET', high: null, low: null, status: 'Open' });
  assert.equal(bar.close, 157.2);
  assert.equal(bar.high, 159.7999);
});

test('pre-market: no bar for the day yet', () => {
  const bar = sessionBar(ticks.slice(0, 2), { price: 158.99, volume: 1e6, time: 'Nov 24, 2026 9:29 AM ET', high: 230.26, low: 125, status: 'Pre-Market' });
  assert.equal(bar.close, null);
  assert.equal(bar.open, null);
});
