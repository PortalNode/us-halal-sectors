// نتائج الشركات الأمريكية الربعية (من financials.json، مصدر TradingView). مأخوذ من صفحات السوق السعودي ومعدّل للدولار.
// المبالغ بمليون دولار وربحية السهم بالدولار. البنود المخزونية (الأصول والدين) تُؤخذ في نهاية الفترة ولا تُجمع.
export const METRICS = [
  { key: 'revenue', label: 'الإيرادات' },
  { key: 'grossProfit', label: 'إجمالي الربح' },
  { key: 'ebitda', label: 'الأرباح قبل الفوائد والضرائب والإهلاك (EBITDA)' },
  { key: 'netIncome', label: 'صافي الربح' },
  { key: 'eps', label: 'ربحية السهم المخففة', unit: 'usd' },
  { key: 'freeCashFlow', label: 'التدفق النقدي الحر' },
  { key: 'capex', label: 'النفقات الرأسمالية' },
  { key: 'assets', label: 'إجمالي الأصول', stock: true },
  { key: 'debt', label: 'إجمالي الدين', stock: true },
  { key: 'grossMargin', label: 'هامش إجمالي الربح', unit: 'percent' },
  { key: 'netMargin', label: 'هامش صافي الربح', unit: 'percent' },
  { key: 'fcfMargin', label: 'هامش التدفق النقدي الحر', unit: 'percent' }
];
/** بنود مخزونية: قيمة الفترة التراكمية هي قيمة آخر ربع فيها لا مجموع الأرباع. */
export const STOCK_KEYS = new Set(METRICS.filter(metric => metric.stock).map(metric => metric.key));
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
export const numericValue = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function annualChange(current, previous) {
  current = numericValue(current); previous = numericValue(previous);
  if (current === null || previous === null || previous === 0) return null;
  const result = (current - previous) / Math.abs(previous) * 100;
  return Number.isFinite(result) ? result : null;
}

// Period views built from standalone quarters: one quarter across years, the last
// eight quarters in sequence, or year-to-date sums (6 months = Q1+Q2, 9 months = Q1..Q3).
export const PERIODS = {
  q: { label: 'ربع' },
  h1: { label: '6 أشهر', quarters: 2, range: 'يناير – يونيو', short: '6M' },
  m9: { label: '9 أشهر', quarters: 3, range: 'يناير – سبتمبر', short: '9M' },
  fy: { label: 'سنوي', range: 'السنة المالية كاملة' }
};
export const QUARTER_NAMES = ['', 'الأول', 'الثاني', 'الثالث', 'الرابع'];
export const MONTH_NAMES = ['', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

// Quarters are numbered within the company's fiscal year (as Argaam does), so a company whose
// year ends in July has Q1 = August – October and "6 months" = August – January.
// fiscalYearEnd is the month (1–12) the fiscal year ends in; 12 is a calendar year.
const monthAfter = (month, offset) => (month - 1 + offset) % 12 + 1;
export const isCalendarYear = fiscalYearEnd => !fiscalYearEnd || fiscalYearEnd === 12;
export function monthRange(fiscalYearEnd = 12, firstQuarter = 1, lastQuarter = firstQuarter) {
  const start = monthAfter(fiscalYearEnd || 12, (firstQuarter - 1) * 3 + 1);
  const end = monthAfter(fiscalYearEnd || 12, lastQuarter * 3);
  return `${MONTH_NAMES[start]} – ${MONTH_NAMES[end]}`;
}
/** Month range of a period view for a company, e.g. 'يناير – يونيو' or 'أغسطس – يناير'. */
export function periodRange(period, fiscalYearEnd = 12) {
  const { quarters, range } = PERIODS[period];
  return quarters ? monthRange(fiscalYearEnd, 1, quarters) : range;
}
export const SEQUENCE_LENGTH = 8;
const formatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const MARGINS = { grossMargin: 'grossProfit', netMargin: 'netIncome', fcfMargin: 'freeCashFlow' };
// A sector page may export its own PERIOD_SPEC from its metrics module: { metrics, ratios(values) }.
// ratios returns the derived percentages for a set of summed values. Pages without one use the nine standard items.
export const DEFAULT_PERIOD_SPEC = {
  metrics: METRICS,
  ratios(values) {
    const result = {};
    for (const [key, numerator] of Object.entries(MARGINS)) {
      const top = numericValue(values[numerator]), revenue = numericValue(values.revenue);
      result[key] = top !== null && revenue ? top / revenue : null;
    }
    return result;
  }
};
const summable = spec => spec.metrics.filter(metric => metric.unit !== 'percent').map(metric => metric.key);

const hasData = values => !!values && Object.values(values).some(value => numericValue(value) !== null);
export const quarterLabel = key => `Q${key.slice(5)} ${key.slice(0, 4)}`;
export const periodUnit = key => key === 'eps' ? 'usd' : /Margin$/.test(key) ? 'percent' : 'money';

export function withMargins(values, spec = DEFAULT_PERIOD_SPEC) {
  if (!values) return null;
  return { ...values, ...spec.ratios(values) };
}

export function sumQuarters(company, year, count, spec = DEFAULT_PERIOD_SPEC) {
  const quarters = [];
  for (let quarter = 1; quarter <= count; quarter += 1) {
    const values = company.quarters?.[`${year}Q${quarter}`];
    if (!hasData(values)) return null;
    quarters.push(values);
  }
  const totals = {};
  for (const key of summable(spec)) {
    const parts = quarters.map(values => numericValue(values[key]));
    if (STOCK_KEYS.has(key)) totals[key] = parts.at(-1);
    else totals[key] = parts.includes(null) ? null : Number(parts.reduce((sum, value) => sum + value, 0).toFixed(6));
  }
  return hasData(totals) ? withMargins(totals, spec) : null;
}

/** Columns for a non-annual period: [{ id, label, sub, values, previous }] oldest first. */
export function buildPeriodColumns(company, period, quarter = '3', spec = DEFAULT_PERIOD_SPEC) {
  const keys = Object.keys(company?.quarters ?? {}).filter(key => hasData(company.quarters[key])).sort();
  const years = [...new Set(keys.map(key => Number(key.slice(0, 4))))].sort((a, b) => a - b);
  let columns;
  if (period === 'h1' || period === 'm9') {
    const { quarters, short, label } = PERIODS[period];
    columns = years.map(year => ({ id: String(year), label: String(year), chartLabel: `${short} ${year}`, sub: label, values: sumQuarters(company, year, quarters, spec) }));
  } else if (period === 'q' && quarter === 'seq') {
    columns = keys.slice(-SEQUENCE_LENGTH).map(key => {
      const year = Number(key.slice(0, 4)), number = key.slice(5);
      return { id: key, label: quarterLabel(key), values: withMargins(company.quarters[key], spec), sameQuarterLastYear: withMargins(company.quarters[`${year - 1}Q${number}`], spec) };
    });
  } else if (period === 'q') {
    columns = years.map(year => ({ id: `${year}Q${quarter}`, label: quarterLabel(`${year}Q${quarter}`), values: withMargins(company.quarters[`${year}Q${quarter}`], spec) }));
  } else throw new Error(`unknown period ${period}`);
  return columns.filter(column => hasData(column.values));
}

/** Shape the columns like an annual company record so the existing bar chart can draw them. */
export function chartCompanyFor(company, columns) {
  return { symbol: company.symbol, name: company.name, years: columns.map(column => ({ year: column.chartLabel ?? column.label, period: 'FY', values: column.values })) };
}

function formatValue(value, unit) {
  value = numericValue(value);
  if (value === null) return '<span class="missing" title="غير متاح">—</span>';
  const display = unit === 'percent' ? value * 100 : value;
  return `<span class="num${value < 0 ? ' down' : ''}">${(unit === 'usd' || unit === 'percent' ? formatter : moneyFormatter).format(display)}${unit === 'percent' ? '%' : ''}</span>`;
}
function formatChange(current, previous) {
  const value = annualChange(current, previous);
  if (value === null) return '<span class="missing" title="لا يمكن حساب التغير">—</span>';
  const zero = Math.abs(value) < 0.005;
  return `<span class="num ${zero ? 'flat' : value > 0 ? 'up' : 'down'}">${!zero && value > 0 ? '+' : ''}${formatter.format(zero ? 0 : value)}%</span>`;
}

/**
 * Table for a period view. Each change compares with the same period a year earlier:
 * the previous column for year-over-year views, or the stored same-quarter-last-year
 * values in the sequential view (so seasonality does not distort the change).
 */
export function renderPeriodTable(company, columns, { sequential = false, caption = '', metrics = METRICS } = {}) {
  const latest = columns.at(-1)?.id;
  const fullLabel = column => column ? (column.sub ? `${column.sub} ${column.label}` : column.label) : '';
  const latestLabel = fullLabel(columns.at(-1));
  const compareLabel = sequential
    ? (columns.at(-1) ? quarterLabel(`${Number(columns.at(-1).id.slice(0, 4)) - 1}Q${columns.at(-1).id.slice(5)}`) : '')
    : fullLabel(columns.at(-2));
  // Only the year immediately before counts: when a year is missing (fiscal-year change, late listing)
  // the column before is two or more years back and must not be shown as a year-over-year change.
  const yearOf = column => Number(String(column?.id ?? '').slice(0, 4));
  const reference = (index, key) => {
    if (sequential) return columns[index].sameQuarterLastYear?.[key] ?? null;
    const previous = columns[index - 1];
    return previous && yearOf(previous) === yearOf(columns[index]) - 1 ? previous.values?.[key] ?? null : null;
  };
  const hasChangeCell = index => sequential || index > 0;
  const headerCell = column => `<th scope="col"${column.id === latest ? ' class="period-latest"' : ''}><bdi dir="ltr">${escapeHtml(column.label)}</bdi>${column.sub ? `<span class="period-sub">${escapeHtml(column.sub)}</span>` : ''}</th>`;
  const render = (metrics, withChanges, tableCaption, tableClass) => {
    const colgroup = '<col class="annual-col-label">' + columns.map((_, index) => (hasChangeCell(index) ? '<col class="annual-col-change">' : '') + '<col class="annual-col-value">').join('');
    const header = `<tr><th scope="col" class="annual-label">البند</th>${columns.map((column, index) => (hasChangeCell(index) ? (withChanges ? `<th scope="col" class="annual-change-heading">${sequential ? 'تغير سنوي' : 'نسبة التغير'}</th>` : '<th scope="col" class="annual-change-heading annual-change-spacer" aria-label="فاصل محاذاة"></th>') : '') + headerCell(column)).join('')}</tr>`;
    const rows = metrics.map(metric => {
      const suffix = metric.unit === 'usd' ? ' (دولار)' : metric.unit === 'percent' ? ' (%)' : ' (مليون دولار)';
      const cells = columns.map((column, index) => {
        const value = column.values?.[metric.key] ?? null;
        const change = !hasChangeCell(index) ? '' : withChanges ? `<td class="annual-change">${formatChange(value, reference(index, metric.key))}</td>` : '<td class="annual-change annual-change-spacer" aria-hidden="true"></td>';
        return `${change}<td>${formatValue(value, metric.unit)}</td>`;
      }).join('');
      return `<tr data-metric="${metric.key}"><th scope="row" class="annual-label">${escapeHtml(metric.label + suffix)}</th>${cells}</tr>`;
    }).join('');
    return `<table class="annual-table period-table${sequential ? ' period-table-seq' : ''} ${tableClass}" data-latest-label="${escapeHtml(latestLabel)}" data-compare-label="${escapeHtml(compareLabel)}"><caption>${escapeHtml(tableCaption)}</caption><colgroup>${colgroup}</colgroup><thead>${header}</thead><tbody>${rows}</tbody></table>`;
  };
  const financial = metrics.filter(metric => metric.unit !== 'percent'), margins = metrics.filter(metric => metric.unit === 'percent');
  return `<div class="annual-financial-section">${render(financial, true, `${company.name} · ${caption}`, 'annual-financial-table')}</div><div class="annual-margin-section"><h3>الهوامش</h3>${render(margins, false, `${company.name} · الهوامش · ${caption}`, 'annual-margin-table')}</div>`;
}

/**
 * سجل شركة بصيغة الصفحات السعودية { symbol, name, fiscalYearEnd, quarters: { '2026Q3': { revenue, ... } } }
 * من سجلها في financials.json: القيم تُحوَّل إلى مليون دولار (ربحية السهم تبقى بالدولار). null عند غياب الربع كله.
 */
export function companyFromFinancials(symbol, name, record) {
  const q = record?.quarterly;
  if (!q?.labels?.length) return null;
  const quarters = {};
  q.labels.forEach((label, index) => {
    const key = String(label).replace('-', '');
    if (!/^\d{4}Q[1-4]$/.test(key)) return;
    const values = {};
    for (const metric of METRICS) {
      if (metric.unit === 'percent') continue;
      const raw = numericValue(q[metric.key]?.[index]);
      values[metric.key] = raw === null ? null : metric.unit === 'usd' ? raw : raw / 1e6;
    }
    if (hasData(values)) quarters[key] = values; // الهوامش تُشتق عند بناء الأعمدة
  });
  return Object.keys(quarters).length ? { symbol, name, fiscalYearEnd: q.fiscalYearEnd || 12, quarters } : null;
}
