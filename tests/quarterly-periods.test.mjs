import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { companyFromFinancials, sumQuarters, buildPeriodColumns, renderPeriodTable, periodRange, withMargins, STOCK_KEYS } from '../quarterly-periods.mjs';

// ربعان لكل سنة بقيم بسيطة؛ الأحدث أولًا كما في financials.json
const record = {
  quarterly: {
    labels: ['2026-Q3', '2026-Q2', '2026-Q1', '2025-Q4', '2025-Q3', '2025-Q2', '2025-Q1'],
    fiscalYearEnd: 12,
    revenue: [400e6, 300e6, 200e6, 100e6, 360e6, 270e6, 180e6],
    grossProfit: [200e6, 150e6, 100e6, 50e6, 180e6, 135e6, 90e6],
    netIncome: [40e6, 30e6, 20e6, 10e6, 36e6, 27e6, 18e6],
    eps: [4, 3, 2, 1, 3.6, 2.7, 1.8],
    assets: [1000e6, 900e6, 800e6, 700e6, 950e6, 850e6, 750e6],
  },
};
const company = companyFromFinancials('XYZ', 'اختبار', record);

test('adapter: quarter keys, millions of dollars, EPS stays in dollars, no margins stored', () => {
  assert.deepEqual(Object.keys(company.quarters).sort(), ['2025Q1', '2025Q2', '2025Q3', '2025Q4', '2026Q1', '2026Q2', '2026Q3']);
  assert.equal(company.quarters['2026Q3'].revenue, 400);
  assert.equal(company.quarters['2026Q3'].eps, 4);
  assert.equal('grossMargin' in company.quarters['2026Q3'], false);
  assert.equal(companyFromFinancials('A', 'a', { quarterly: { labels: [] } }), null);
  assert.equal(companyFromFinancials('A', 'a', undefined), null);
});

test('6 and 9 months add quarters; assets/debt take the last quarter, never a sum', () => {
  const h1 = sumQuarters(company, 2026, 2), m9 = sumQuarters(company, 2026, 3);
  assert.equal(h1.revenue, 500); assert.equal(m9.revenue, 900);
  assert.equal(h1.assets, 900); assert.equal(m9.assets, 1000);
  assert.ok(STOCK_KEYS.has('assets') && STOCK_KEYS.has('debt') && !STOCK_KEYS.has('revenue'));
  const fy2025 = sumQuarters(company, 2025, 4); assert.equal(fy2025.revenue, 910); assert.equal(fy2025.assets, 700); // سنة كاملة
  assert.equal(sumQuarters(company, 2026, 4), null); // الربع الرابع لسنة 2026 لم يُعلن بعد
  assert.ok(Math.abs(h1.grossMargin - 0.5) < 1e-9);
  assert.equal(sumQuarters(company, 2024, 2), null); // سنة بلا أرباع
});

test('period columns: one quarter across years, sequence, year-to-date', () => {
  assert.deepEqual(buildPeriodColumns(company, 'q', '3').map(c => c.label), ['Q3 2025', 'Q3 2026']);
  const seq = buildPeriodColumns(company, 'q', 'seq');
  assert.equal(seq.at(-1).label, 'Q3 2026');
  assert.equal(seq.at(-1).sameQuarterLastYear.revenue, 360); // مقارنة الربع نفسه من العام السابق
  assert.deepEqual(buildPeriodColumns(company, 'h1').map(c => c.id), ['2025', '2026']);
  assert.throws(() => buildPeriodColumns(company, 'zz'));
});

test('fiscal-year ranges and table units', () => {
  assert.equal(periodRange('h1', 12), 'يناير – يونيو');
  assert.equal(periodRange('h1', 9), 'أكتوبر – مارس'); // سنة تنتهي في سبتمبر
  assert.equal(periodRange('m9', 6), 'يوليو – مارس');
  const html = renderPeriodTable(company, buildPeriodColumns(company, 'q', 'seq'), { sequential: true, caption: 'x' });
  assert.match(html, /\(مليون دولار\)/); assert.match(html, /\(دولار\)/); assert.match(html, /\(%\)/); assert.doesNotMatch(html, /ريال/);
});

test('margins derive from totals', () => {
  assert.ok(Math.abs(withMargins({ revenue: 200, grossProfit: 50, netIncome: 20, freeCashFlow: 10 }).netMargin - 0.1) < 1e-9);
  assert.equal(withMargins({ revenue: 0, grossProfit: 5 }).grossMargin, null);
});

test('financials.json: quarters start no earlier than 2022 and the fiscal year end is a month', () => {
  const fin = JSON.parse(readFileSync(new URL('../financials.json', import.meta.url), 'utf8')).companies;
  let withQuarters = 0;
  for (const [symbol, c] of Object.entries(fin)) {
    const q = c.quarterly; if (!q?.labels?.length) continue;
    withQuarters += 1;
    assert.ok(Number(q.labels.at(-1).slice(0, 4)) >= 2022, symbol);
    assert.ok(Number.isInteger(q.fiscalYearEnd) && q.fiscalYearEnd >= 1 && q.fiscalYearEnd <= 12, symbol);
    for (const key of ['revenue', 'netIncome', 'eps', 'assets']) assert.equal(q[key].length, q.labels.length, `${symbol} ${key}`);
  }
  assert.ok(withQuarters > 200);
});
