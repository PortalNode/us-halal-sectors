// صفحة «نتائج الشركات»: النتائج المالية السنوية لكل شركة (من financials.json) مع نبذة وبطاقة السهم.
// بطاقة السهم والشارت المصغر يضيفهما company-quote.js تحت النبذة، اعتمادًا على شارة الرمز في العنوان.
// الفترات (ربع / 6 أشهر / 9 أشهر / سنوي / أرباع متتالية) كما في صفحات السوق السعودي: quarterly-periods.mjs.
import { PERIODS, QUARTER_NAMES, METRICS as QMETRICS, periodRange, periodUnit, quarterLabel, numericValue, companyFromFinancials, buildPeriodColumns, renderPeriodTable, MONTH_NAMES, isCalendarYear, monthRange } from './quarterly-periods.mjs?v=us-q-20261119';
(() => {
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const f2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const read = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

  // البنود: [مفتاح، تسمية، نوع]  money = مليون دولار، ps = دولار للسهم، pct = نسبة مشتقة
  const METRICS = [
    ['revenue', 'الإيرادات', 'money'], ['grossProfit', 'إجمالي الربح', 'money'], ['ebitda', 'الأرباح قبل الفوائد والضرائب والإهلاك (EBITDA)', 'money'],
    ['netIncome', 'صافي الربح', 'money'], ['eps', 'ربحية السهم المخففة', 'ps'], ['epsBasic', 'ربحية السهم الأساسية', 'ps'],
    ['dps', 'التوزيع النقدي للسهم', 'ps'], ['freeCashFlow', 'التدفق النقدي الحر', 'money'], ['capex', 'النفقات الرأسمالية', 'money'],
    ['assets', 'إجمالي الأصول', 'money'], ['debt', 'إجمالي الدين', 'money'],
    ['grossMargin', 'هامش إجمالي الربح', 'pct', ['grossProfit', 'revenue']], ['netMargin', 'هامش صافي الربح', 'pct', ['netIncome', 'revenue']],
    ['fcfMargin', 'هامش التدفق النقدي الحر', 'pct', ['freeCashFlow', 'revenue']]
  ];
  const state = { data: null, fin: null, profiles: {}, symbol: null, metric: 'netIncome', period: 'fy', quarter: null };
  let qCompany = null, periodColumns = []; // سجل الشركة الربعي وأعمدة الفترة المختارة (غير السنوية)
  const periodSummary = () => state.period === 'q' ? (state.quarter === 'seq' ? 'آخر الأرباع المتتالية' : `الربع ${QUARTER_NAMES[state.quarter]} عبر السنوات`)
    : state.period === 'fy' ? 'النتائج السنوية' : `${PERIODS[state.period].label} (${periodRange(state.period, qCompany?.fiscalYearEnd)})`;
  const latestQuarterKey = () => Object.keys(qCompany?.quarters || {}).sort().at(-1) || null;

  // الفترة: 'fy' سنوي (آخر 5 سنوات مالية) أو 'q' ربعي (آخر 8 أرباع). الأحدث أولًا في المصفوفات.
  const periodData = company => {
    if (state.period === 'q') {
      const q = company?.quarterly || {};
      return { src: q, labels: (q.labels || []).slice(0, 8), step: 4 };
    }
    const a = company?.annual || {};
    return { src: a, labels: (a.years || []).slice(0, 5), step: 1 };
  };
  const labelOf = l => state.period === 'q' ? `${String(l).slice(5)} ${String(l).slice(0, 4)}` : String(l);
  const series = (company, key) => {
    const { src, labels } = periodData(company);
    const metric = METRICS.find(m => m[0] === key);
    if (metric?.[2] === 'pct') {
      const [a, b] = metric[3];
      return labels.map((_, i) => { const x = num(src[a]?.[i]), y = num(src[b]?.[i]); return x == null || !y ? null : x / y * 100; });
    }
    return labels.map((_, i) => num(src[key]?.[i]));
  };
  const fmt = (v, kind) => v == null ? '<span class="missing">—</span>' : kind === 'money' ? `<span class="num">${f0.format(v / 1e6)}</span>` : kind === 'ps' ? `<span class="num">${f2.format(v)}</span>` : `<span class="num">${f2.format(v)}%</span>`;
  const plain = (v, kind) => v == null ? '—' : kind === 'money' ? f0.format(v / 1e6) : kind === 'ps' ? f2.format(v) : `${f2.format(v)}%`;
  function change(cur, prev, kind) {
    if (cur == null || prev == null) return '<span class="missing">—</span>';
    if (kind === 'pct') { const d = cur - prev; return `<span class="num ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${d > 0 ? '+' : ''}${f2.format(d)} ن.م.</span>`; }
    if (prev === 0) return '<span class="missing">—</span>';
    // عند سالب سابق يُقاس التغير على القيمة المطلقة حتى لا ينقلب اتجاه الإشارة
    const pct = (cur - prev) / Math.abs(prev) * 100;
    return `<span class="num ${pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'}">${pct > 0 ? '+' : ''}${f2.format(pct)}%</span>`;
  }

  function pickers(stocks) {
    const bar = document.querySelector('.site-bar .site-name');
    if (!bar || document.querySelector('.sector-switch')) return;
    const sectorLabel = document.createElement('label');
    sectorLabel.className = 'sector-switch';
    sectorLabel.innerHTML = '<span>القطاع</span>';
    const sectorSelect = document.createElement('select');
    sectorSelect.setAttribute('aria-label', 'التبديل إلى قطاع آخر');
    for (const s of state.data.sectors) sectorSelect.add(new Option(s.name, s.key));
    sectorLabel.append(sectorSelect);
    const companyLabel = document.createElement('label');
    companyLabel.className = 'sector-switch company-switch';
    companyLabel.innerHTML = '<span>الشركة</span>';
    const companySelect = document.createElement('select');
    companySelect.setAttribute('aria-label', 'اختيار شركة من القطاع');
    companyLabel.append(companySelect);
    bar.after(sectorLabel);
    sectorLabel.after(companyLabel);
    const fill = key => {
      const sector = state.data.sectors.find(s => s.key === key);
      companySelect.replaceChildren(...sector.stocks.map(s => new Option(`${s.name} · ${s.symbol}`, s.symbol)));
    };
    sectorSelect.addEventListener('change', () => { fill(sectorSelect.value); show(companySelect.options[0].value); });
    companySelect.addEventListener('change', () => show(companySelect.value));
    state.sync = symbol => {
      const sector = state.data.sectors.find(s => s.stocks.some(x => x.symbol === symbol));
      sectorSelect.value = sector.key; fill(sector.key); companySelect.value = symbol;
    };
    document.body.classList.add('has-company-switch');
  }

  const years = n => n === 1 ? 'سنة واحدة' : n === 2 ? 'سنتان' : n >= 3 && n <= 10 ? `${n} سنوات` : `${n} سنة`;
  const months = n => n === 1 ? 'شهر' : n === 2 ? 'شهران' : n >= 3 && n <= 10 ? `${n} أشهر` : `${n} شهرًا`;
  const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const toDate = iso => new Date(`${iso}T12:00:00`);
  const dotDate = iso => iso.split('-').reverse().join('.');
  const dateLabel = (iso, precision) => precision === 'year' ? iso.slice(0, 4) : precision === 'month' ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : dotDate(iso);
  function diff(fromIso, to) {
    const from = toDate(fromIso);
    let y = to.getFullYear() - from.getFullYear(), m = to.getMonth() - from.getMonth();
    if (to.getDate() < from.getDate()) m--;
    if (m < 0) { y--; m += 12; }
    return { y, m };
  }
  const span = ({ y, m }) => y && m ? `${years(y)} و${months(m)}` : y ? years(y) : m ? months(m) : 'أقل من شهر';

  function profile(stock, sector, company) {
    const p = state.profiles[stock.symbol] || {};
    const today = new Date();
    const founded = p.founded ? toDate(p.founded) : null, listed = p.listed ? toDate(p.listed) : null;
    const weight = stock.shariahWeight != null ? `${f2.format(stock.shariahWeight)}%` : null;
    const employees = num(company?.employees) ? f0.format(company.employees) : null;
    const tags = `<span class="cp-tag market">${esc(stock.exchange || '')}</span><span class="cp-tag">${esc(stock.nameEn || '')}</span>${weight ? `<span class="cp-tag" title="وزن الشركة في صندوق SPUS">الوزن في SPUS ${weight}</span>` : ''}${employees ? `<span class="cp-tag">الموظفون ${employees}</span>` : ''}<span class="cp-tag">المصدر: ${p.activity || p.founded ? 'ويكيبيديا · ويكيداتا' : 'تريدينغ فيو'}</span>`;
    const activity = p.activity
      ? `<p>${esc(p.activity)}</p>${p.activityLang === 'en' ? '<p class="cp-official">النص من ويكيبيديا الإنجليزية لعدم توفر صفحة عربية للشركة.</p>' : ''}`
      : `<p>${esc(stock.industry || sector.name)}</p>`;
    const official = `<p class="cp-official">${esc(sector.name)}${stock.industry ? ` · ${esc(stock.industry)}` : ''}${p.wiki ? ` · <a href="${esc(p.wiki)}" target="_blank" rel="noopener">المزيد في ويكيبيديا</a>` : ''}</p>`;
    const age = founded && diff(p.founded, today), listedAge = listed && diff(p.listed, today), gap = founded && listed && diff(p.founded, listed);
    const missing = label => `<div class="cp-fact cp-missing"><span class="cp-label">${label}</span><span class="cp-year">—</span><span class="cp-date">غير متوفر في المصدر</span></div>`;
    const foundedFact = founded
      ? `<div class="cp-fact"><span class="cp-label">تاريخ التأسيس</span><span class="cp-year">${founded.getFullYear()}</span><span class="cp-date"${p.foundedPrecision !== 'day' ? ' style="direction:rtl"' : ''}>${dateLabel(p.founded, p.foundedPrecision)}</span><span class="cp-ago">منذ ${years(age.y)}</span></div>`
      : missing('تاريخ التأسيس');
    const listedFact = listed
      ? `<div class="cp-fact listed" title="مصدر تاريخ الإدراج: ويكيداتا (بداية الإدراج في ${esc(stock.exchange || 'البورصة')})"><span class="cp-label">تاريخ الإدراج في ${esc(stock.exchange || 'البورصة')}</span><span class="cp-year">${listed.getFullYear()}</span><span class="cp-date"${p.listedPrecision !== 'day' ? ' style="direction:rtl"' : ''}>${dateLabel(p.listed, p.listedPrecision)}</span><span class="cp-ago">مدرجة منذ ${years(listedAge.y)}</span></div>`
      : missing('تاريخ الإدراج');
    const gapFact = `<div class="cp-fact gap"><span class="cp-label">من التأسيس إلى الإدراج</span><span class="cp-gap ${gap ? '' : 'none'}">${gap ? span(gap) : '—'}</span></div>`;
    let timeline = '';
    if (founded) {
      const pos = d => Math.max(0, Math.min(100, (d - founded) / (today - founded) * 100)).toFixed(2);
      timeline = `<div class="cp-timeline" role="img" aria-label="تأسست ${founded.getFullYear()}${listed ? `، وأُدرجت ${listed.getFullYear()}` : ''}">
          <div class="cp-track">
            ${listed ? `<div class="cp-listed-seg" style="right:${pos(listed)}%"></div>` : ''}
            <span class="cp-dot" style="right:0%"></span>
            ${listed ? `<span class="cp-dot gold" style="right:${pos(listed)}%"></span>` : ''}
            <span class="cp-dot today" style="right:100%"></span>
            <span class="cp-tick" style="right:0%"><b>${founded.getFullYear()}</b>التأسيس</span>
            ${listed ? `<span class="cp-tick gold" style="right:${pos(listed)}%"><b>${listed.getFullYear()}</b>الإدراج</span>` : ''}
            <span class="cp-tick" style="right:100%"><b>${today.getFullYear()}</b>اليوم</span>
          </div>
          <div class="cp-legend"><span><i></i>${listed ? 'قبل الإدراج' : 'منذ التأسيس'}</span>${listed ? '<span><i class="gold"></i>مدرجة في السوق</span>' : ''}</div>
        </div>`;
    }
    return `<div class="cp-head"><h3 id="cp-title">نبذة عن الشركة</h3><div class="cp-tags">${tags}</div></div>
      <div class="cp-body">
        <div class="cp-activity"><span class="cp-label">مجال العمل</span>${activity}${official}</div>
        <div class="cp-facts">${foundedFact}${listedFact}${gapFact}</div>
        ${timeline}
      </div>`;
  }

  // تسميات الخط الزمني تتداخل إذا تقاربت سنواتها: كل تسمية متداخلة تنزل صفًا أدنى.
  function layoutTicks(timeline) {
    const ticks = [...timeline.querySelectorAll('.cp-tick')];
    ticks.forEach(tick => tick.classList.remove('row2', 'row3'));
    timeline.dataset.rows = '1';
    const rects = ticks.map(tick => tick.getBoundingClientRect());
    if (!rects.length || !rects[0].width) return;
    const rows = [];
    ticks.forEach((tick, i) => {
      const r = rects[i];
      let k = 0;
      while ((rows[k] ??= []).some(o => !(r.right + 4 <= o.left || r.left >= o.right + 4))) k++;
      rows[k].push(r);
      if (k) tick.classList.add(`row${Math.min(k + 1, 3)}`);
    });
    timeline.dataset.rows = String(Math.min(rows.length, 3));
  }
  const tickObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => entries.forEach(e => layoutTicks(e.target))) : null;

  function keyFigures(company) {
    const ttm = company?.ttm || {};
    const cells = [
      ['الإيرادات (12 شهرًا)', plain(num(ttm.revenue), 'money'), 'مليون $'], ['صافي الربح (12 شهرًا)', plain(num(ttm.netIncome), 'money'), 'مليون $'],
      ['هامش صافي الربح', num(ttm.netMargin) == null ? '—' : `${f2.format(ttm.netMargin)}%`, ''], ['هامش التشغيل', num(ttm.operatingMargin) == null ? '—' : `${f2.format(ttm.operatingMargin)}%`, ''],
      ['التدفق النقدي الحر', plain(num(ttm.freeCashFlow), 'money'), 'مليون $'], ['العائد على حقوق المساهمين', num(company?.roe) == null ? '—' : `${f2.format(company.roe)}%`, ''],
      ['الدين إلى حقوق الملكية', num(company?.debtToEquity) == null ? '—' : f2.format(company.debtToEquity), 'مرة']
    ];
    $('kf-title').textContent = `آخر النتائج المالية: آخر 12 شهرًا${company?.fiscalPeriod ? ` (حتى ${company.fiscalPeriod})` : ''}`;
    $('kf').innerHTML = cells.map(([label, value, unit]) => `<div class="key-figure"><dt title="${esc(label)}">${esc(label)}</dt><dd>${esc(value)}</dd><small><span>${esc(unit) || '&nbsp;'}</span></small></div>`).join('');
  }

  function periodTable() {
    const sequential = state.period === 'q' && state.quarter === 'seq';
    const shown = QMETRICS.filter(m => periodColumns.some(c => numericValue(c.values?.[m.key]) !== null));
    $('bank-table-wrap').innerHTML = periodColumns.length
      ? renderPeriodTable(qCompany, periodColumns, { sequential, caption: periodSummary(), metrics: shown })
      : '<p class="financial-status">لا تتوفر نتائج ربعية لهذه الفترة في المصدر.</p>';
  }

  function table(company) {
    if (state.period !== 'fy') return periodTable();
    const { labels, step } = periodData(company);
    if (!labels.length) { $('bank-table-wrap').innerHTML = `<p class="financial-status">لا تتوفر نتائج ${state.period === 'q' ? 'ربعية' : 'سنوية'} لهذه الشركة في المصدر.</p>`; return; }
    const order = labels.map((_, i) => i).reverse(); // الأقدم أولًا ثم الأحدث
    const head = `<tr><th class="annual-label annual-col-label" scope="col">البند</th>${order.map((i, k) => `${k === 0 && state.period !== 'q' ? '' : `<th class="annual-col-change annual-change-heading" scope="col">${state.period === 'q' ? 'عن الربع نفسه' : 'التغير'}</th>`}<th class="annual-col-value" scope="col">${esc(labelOf(labels[i]))}</th>`).join('')}</tr>`;
    const rows = METRICS.map(([key, label, kind]) => {
      const s = series(company, key);
      if (s.every(v => v == null)) return '';
      return `<tr data-metric="${key}"><th class="annual-label" scope="row">${esc(label)}<small>${kind === 'money' ? 'مليون دولار' : kind === 'ps' ? 'دولار للسهم' : 'نسبة مئوية'}</small></th>${order.map((i, k) => `${k === 0 && state.period !== 'q' ? '' : `<td class="annual-change">${change(s[i], s[i + step] ?? null, kind)}</td>`}<td class="annual-value">${fmt(s[i], kind)}</td>`).join('')}</tr>`;
    }).join('');
    $('bank-table-wrap').innerHTML = `<table class="annual-table"><caption class="sr-only">النتائج المالية ${state.period === 'q' ? 'الربعية' : 'السنوية'}</caption><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  function drawBars(title, items, kind) {
    $('bank-charts-context').textContent = title;
    if (!items.length) { $('bank-charts-grid').innerHTML = '<p class="financial-status">لا تتوفر بيانات لهذا البند.</p>'; return; }
    $('bank-charts-grid').innerHTML = barChart(items, kind, title);
  }

  // أعمدة المقارنة (بأسلوب el7): تدرّج يتلاشى للأسفل، آخر فترة مميّزة بتوهّج، شبكة منقّطة بمحور قيم،
  // ونسبة التغير عن الفترة السابقة فوق كل عمود، وملخص التغير الكلي أعلى البطاقة.
  // items: [{ label, value, tip? }] من الأقدم إلى الأحدث. kind: money | ps | pct | percent
  function barChart(items, kind, ariaLabel) {
    const pctKind = kind === 'pct' || kind === 'percent';
    const text = v => (kind === 'money' ? f0.format(v) : f2.format(v)) + (pctKind ? '%' : '');
    const tickText = v => (kind === 'money' ? f0 : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })).format(v) + (pctKind ? '%' : '');
    const delta = (cur, prev) => {
      if (cur == null || prev == null) return null;
      if (pctKind) { const d = cur - prev; return { d, t: `${d > 0 ? '+' : ''}${f2.format(d)} ن.م.` }; }
      if (prev === 0) return null;
      const d = (cur - prev) / Math.abs(prev) * 100;
      return { d, t: `${d > 0 ? '+' : ''}${f2.format(d)}%` };
    };
    const vals = items.map(x => x.value);
    // على الشاشات الضيقة نرسم بعرض أصغر حتى يبقى النص مقروءًا بعد التصغير
    const narrow = ($('bank-charts-grid')?.clientWidth || window.innerWidth) < 600;
    const W = narrow ? 420 : 760, H = narrow ? 320 : 300, padL = 8, padR = narrow ? 46 : 62, padT = 62, padB = 36;
    const max = Math.max(0, ...vals), min = Math.min(0, ...vals);
    const raw = (max - min || 1) / 4, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= raw - 1e-9);
    const hi = Math.ceil(max / step - 1e-9) * step || step, lo = Math.floor(min / step + 1e-9) * step, span = hi - lo || 1;
    const y = v => padT + (hi - v) / span * (H - padT - padB);
    const ticks = []; for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t / step) * step);
    const plotW = W - padL - padR, gap = plotW / items.length, bw = Math.min(66, gap * 0.6), last = items.length - 1;
    // كثرة الأعمدة (الأرباع المتتالية): نخفي نسب التغير ثم القيم عدا الأخيرة، ونصغّر تسميات الفترات
    const showChips = gap >= 58, showVals = gap >= 40, xSize = gap >= 52 ? 12 : gap >= 34 ? 10 : 8.5;
    const grid = ticks.map(t => `<line class="e7c-grid${t === 0 ? ' e7c-zero' : ''}" x1="${padL}" x2="${W - padR + 4}" y1="${y(t)}" y2="${y(t)}"/><text class="e7c-ytick" x="${W - padR + 10}" y="${y(t) + 4}">${tickText(t)}</text>`).join('');
    const path = (x, top, w, h, up) => {
      const r = Math.min(8, w / 2, h);
      return up
        ? `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h}Z`
        : `M${x},${top}V${top + h - r}Q${x},${top + h} ${x + r},${top + h}H${x + w - r}Q${x + w},${top + h} ${x + w},${top + h - r}V${top}Z`;
    };
    const bars = items.map((item, k) => {
      const v = item.value, up = v >= 0, x = padL + gap * k + (gap - bw) / 2, cx = x + bw / 2;
      const top = y(Math.max(v, 0)), h = Math.max(Math.abs(y(v) - y(0)), 1.5), isLast = k === last;
      const ch = k > 0 && !pctKind ? delta(v, items[k - 1].value) : null; // الهوامش والنسب: بلا نسبة تغير
      const valY = up ? top - 10 : top + h + 17;
      const chipY = up ? top - 38 : y(0) - 24; // للأعمدة السالبة: النسبة فوق خط الصفر بعيدًا عن تسمية الفترة
      const chip = ch && showChips ? (() => { const w = ch.t.length * 6.3 + 14; return `<g class="e7c-chip ${ch.d > 0 ? 'up' : ch.d < 0 ? 'down' : 'flat'}"><rect x="${cx - w / 2}" y="${chipY}" width="${w}" height="17" rx="8.5"/><text x="${cx}" y="${chipY + 12.5}">${ch.t}</text></g>`; })() : '';
      const tip = `${item.label}: ${item.tip ?? text(v)}${ch ? ` (${ch.t})` : ''}`;
      return `<g class="e7c-bar${isLast ? ' is-last' : ''}${up ? '' : ' is-neg'}" style="--i:${k}"><title>${esc(tip)}</title>`
        + `<rect class="e7c-hit" x="${padL + gap * k}" y="${padT - 40}" width="${gap}" height="${H - padT + 40 - padB}"/>`
        + `<path class="e7c-fill" d="${path(x, top, bw, h, up)}" fill="url(#e7c-${up ? 'up' : 'down'}${isLast ? '-last' : ''})"${isLast && up ? ' filter="url(#e7c-glow)"' : ''}/>`
        + `<rect class="e7c-cap" x="${x + 3}" y="${up ? top : top + h - 3}" width="${Math.max(bw - 6, 1)}" height="3" rx="1.5"/>`
        + (showVals || isLast ? `<text class="e7c-val" x="${cx}" y="${valY}">${text(v)}</text>` : '') + chip
        + `<text class="e7c-x" x="${cx}" y="${H - 10}" font-size="${xSize}">${esc(item.label)}</text></g>`;
    }).join('');
    const stops = (id, a, b, flip) => `<linearGradient id="${id}" x1="0" y1="${flip ? 1 : 0}" x2="0" y2="${flip ? 0 : 1}"><stop offset="0" class="${a}"/><stop offset="1" class="${b}"/></linearGradient>`;
    const defs = `<defs>${stops('e7c-up', 'e7c-up-a', 'e7c-up-b')}${stops('e7c-up-last', 'e7c-upl-a', 'e7c-upl-b')}${stops('e7c-down', 'e7c-dn-a', 'e7c-dn-b', true)}${stops('e7c-down-last', 'e7c-dnl-a', 'e7c-dnl-b', true)}<filter id="e7c-glow" x="-50%" y="-20%" width="200%" height="140%"><feDropShadow dx="0" dy="0" stdDeviation="7" class="e7c-glow"/></filter></defs>`;
    // الملخص: التغير من أول فترة إلى آخرها، وأعلى قيمة
    const total = items.length > 1 && !pctKind ? delta(vals[last], vals[0]) : null;
    const best = items.reduce((a, b) => (b.value > a.value ? b : a), items[0]);
    const pills = `${total ? `<span class="e7c-pill ${total.d > 0 ? 'up' : total.d < 0 ? 'down' : ''}"><i></i>من ${esc(items[0].label)} إلى ${esc(items[last].label)}: <bdi>${total.t}</bdi></span>` : ''}`
      + `<span class="e7c-pill gold"><i></i>آخر قيمة: <bdi>${text(vals[last])}</bdi></span>`
      + (items.length > 2 ? `<span class="e7c-pill"><i></i>الأعلى: ${esc(best.label)} · <bdi>${text(best.value)}</bdi></span>` : '');
    return `<div class="bank-chart-card e7c" style="padding:12px"><div class="e7c-head">${pills}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}" style="width:100%;height:auto;max-height:380px;direction:ltr">${defs}${grid}${bars}</svg></div>`;
  }

  function periodBars() {
    const metric = QMETRICS.find(m => m.key === state.metric) || QMETRICS.find(m => m.key === 'netIncome');
    const kind = periodUnit(metric.key);
    const items = periodColumns.map(c => ({ label: c.chartLabel ?? c.label, value: numericValue(c.values?.[metric.key]) })).filter(x => x.value !== null).map(x => ({ ...x, value: kind === 'percent' ? x.value * 100 : x.value }));
    const unitName = kind === 'money' ? 'مليون دولار' : kind === 'usd' ? 'دولار للسهم' : 'نسبة مئوية';
    drawBars(`${qCompany?.name ?? ''} · ${metric.label} · ${unitName} · ${periodSummary()}`, items, kind === 'usd' ? 'ps' : kind);
  }

  // قائمة بنود الرسم تتبع الفترة: بنود الأرباع غير بنود السنوي (ربحية السهم الأساسية والتوزيع سنويان فقط)
  function fillMetricSelect() {
    const sel = $('bank-chart-metric');
    const options = state.period === 'fy' ? METRICS.map(([k, l]) => [k, l]) : QMETRICS.filter(m => periodColumns.some(c => numericValue(c.values?.[m.key]) !== null)).map(m => [m.key, m.label]);
    if (!options.some(([k]) => k === state.metric)) state.metric = options.some(([k]) => k === 'netIncome') ? 'netIncome' : options[0]?.[0] ?? 'netIncome';
    sel.innerHTML = options.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
    sel.value = state.metric;
  }

  function syncPeriodControls() {
    for (const b of document.querySelectorAll('#bank-period-seg [data-period]')) b.setAttribute('aria-pressed', String(b.dataset.period === state.period));
    for (const b of document.querySelectorAll('#bank-quarter-seg [data-quarter]')) b.setAttribute('aria-pressed', String(b.dataset.quarter === state.quarter));
    $('bank-quarter-group').hidden = state.period !== 'q';
    for (const b of document.querySelectorAll('#bank-period-seg [data-period]')) { const off = b.dataset.period !== 'fy' && !qCompany; b.disabled = off; b.title = off ? 'لا تتوفر نتائج ربعية لهذه الشركة' : ''; }
  }

  function bars(company) {
    if (state.period !== 'fy') return periodBars();
    const metric = METRICS.find(m => m[0] === state.metric) || METRICS[3];
    const s = series(company, metric[0]);
    const { labels } = periodData(company);
    const idx = labels.map((_, i) => i).reverse().filter(i => s[i] != null);
    $('bank-charts-context').textContent = `${metric[1]} · ${metric[2] === 'money' ? 'مليون دولار' : metric[2] === 'ps' ? 'دولار للسهم' : 'نسبة مئوية'} · ${state.period === 'q' ? 'ربعي' : 'سنوي'}`;
    if (!idx.length) { $('bank-charts-grid').innerHTML = '<p class="financial-status">لا تتوفر بيانات لهذا البند.</p>'; return; }
    const items = idx.map(i => ({ label: labelOf(labels[i]), value: metric[2] === 'money' ? s[i] / 1e6 : s[i], tip: plain(s[i], metric[2]) }));
    $('bank-charts-grid').innerHTML = barChart(items, metric[2], metric[1]);
  }

  function show(symbol, { push = true } = {}) {
    const sector = state.data.sectors.find(s => s.stocks.some(x => x.symbol === symbol));
    const stock = sector?.stocks.find(x => x.symbol === symbol);
    if (!stock) { $('bank-load-status').textContent = 'لا توجد شركة بهذا الرمز في القائمة الشرعية.'; return; }
    state.symbol = symbol;
    const company = state.fin.companies[symbol];
    qCompany = companyFromFinancials(symbol, stock.name, company);
    if (state.period !== 'fy' && !qCompany) state.period = 'fy';
    if (!['1', '2', '3', '4', 'seq'].includes(state.quarter)) state.quarter = (latestQuarterKey() || 'x0').slice(5) || 'seq';
    periodColumns = state.period !== 'fy' ? buildPeriodColumns(qCompany, state.period, state.quarter) : [];
    write('us-halal-results-symbol', symbol);
    write('us-halal-results-period', state.period);
    if (push || true) {
      try {
        const url = new URL(location.href);
        url.search = '';
        url.searchParams.set('symbol', symbol);
        if (state.period !== 'fy') url.searchParams.set('period', state.period);
        if (state.period === 'q') url.searchParams.set('q', state.quarter);
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      } catch { /* ignore */ }
    }
    document.title = `${stock.name} | ${periodSummary()} | السوق الأمريكي الشرعي`;
    $('crumb').textContent = `نتائج ${sector.name}`;
    $('bank-title').innerHTML = `${esc(stock.name)} <span class="symbol-badge">${esc(symbol)}</span>`;
    const fy = company?.annual?.years || [];
    $('bank-period-badge').innerHTML = state.period !== 'fy' && latestQuarterKey()
      ? `آخر ربع متاح <bdi dir="ltr">${quarterLabel(latestQuarterKey())}</bdi>`
      : (fy.length ? `آخر ${Math.min(5, fy.length)} سنوات مالية <bdi>${fy[Math.min(4, fy.length - 1)]}–${fy[0]}</bdi>` : '');
    syncPeriodControls();
    $('company-profile').innerHTML = profile(stock, sector, company);
    const timeline = document.querySelector('#company-profile .cp-timeline');
    if (timeline && tickObserver) { tickObserver.disconnect(); tickObserver.observe(timeline); }
    const fye = qCompany?.fiscalYearEnd, offYear = qCompany && !isCalendarYear(fye);
    $('unit-note').textContent = state.period !== 'fy'
      ? `المبالغ بمليون دولار أمريكي وربحية السهم بالدولار. الأرباع مرقّمة حسب السنة المالية للشركة${offYear ? ` (تنتهي في ${MONTH_NAMES[fye]}، فالربع الأول ${monthRange(fye, 1, 1)})` : ' (تنتهي في ديسمبر)'}؛ 6 أشهر = الربعان الأول والثاني، و9 أشهر = الأرباع الثلاثة الأولى. الأصول والدين بنهاية الفترة. التغير مقارنة بالفترة نفسها من السنة السابقة. المصدر: TradingView.`
      : 'المبالغ بمليون دولار أمريكي ما لم يُذكر غير ذلك، والسنة المالية قد تنتهي في غير ديسمبر. التغير سنوي مقارنة بالسنة السابقة، وللنسب بالنقاط المئوية. المصدر: TradingView.';
    keyFigures(company);
    fillMetricSelect();
    table(company);
    bars(company);
    $('bank-load-status').hidden = true;
    $('bank-panel').hidden = false;
    state.sync?.(symbol);
  }

  async function start() {
    try {
      const [data, fin, profiles] = await Promise.all([fetch('data.json').then(r => r.json()), fetch('financials.json').then(r => r.json()), fetch('company-profiles.json').then(r => r.ok ? r.json() : {}).catch(() => ({}))]);
      state.data = data; state.fin = fin; state.profiles = profiles || {};
    } catch (error) { $('bank-load-status').textContent = 'تعذر تحميل بيانات الشركات.'; return; }
    pickers();
    const params0 = new URLSearchParams(location.search);
    const storedPeriod = read('us-halal-results-period');
    const wantedPeriod = params0.get('period') ?? (params0.has('symbol') ? 'fy' : storedPeriod);
    if (['q', 'h1', 'm9'].includes(wantedPeriod)) state.period = wantedPeriod;
    if (['1', '2', '3', '4', 'seq'].includes(params0.get('q'))) state.quarter = params0.get('q');
    for (const button of document.querySelectorAll('#bank-period-seg [data-period]')) {
      button.addEventListener('click', () => { state.period = button.dataset.period; show(state.symbol, { push: false }); });
    }
    for (const button of document.querySelectorAll('#bank-quarter-seg [data-quarter]')) {
      button.addEventListener('click', () => { state.quarter = button.dataset.quarter; show(state.symbol, { push: false }); });
    }
    const sel = $('bank-chart-metric');
    sel.addEventListener('change', () => { state.metric = sel.value; bars(state.fin.companies[state.symbol]); });
    const params = new URLSearchParams(location.search);
    const all = state.data.sectors.flatMap(s => s.stocks);
    let symbol = params.get('symbol');
    if (!all.some(s => s.symbol === symbol)) {
      const sector = state.data.sectors.find(s => s.key === params.get('sector'));
      symbol = sector ? sector.stocks[0].symbol : all.some(s => s.symbol === read('us-halal-results-symbol')) ? read('us-halal-results-symbol') : [...all].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))[0].symbol;
    }
    show(symbol, { push: false });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
