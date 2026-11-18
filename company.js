// صفحة «نتائج الشركات»: النتائج المالية السنوية لكل شركة (من financials.json) مع نبذة وبطاقة السهم.
// بطاقة السهم والشارت المصغر يضيفهما company-quote.js تحت النبذة، اعتمادًا على شارة الرمز في العنوان.
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
  const state = { data: null, fin: null, symbol: null, metric: 'netIncome' };

  const series = (company, key) => {
    const annual = company?.annual || {};
    const metric = METRICS.find(m => m[0] === key);
    if (metric?.[2] === 'pct') {
      const [a, b] = metric[3];
      return (annual.years || []).map((_, i) => { const x = num(annual[a]?.[i]), y = num(annual[b]?.[i]); return x == null || !y ? null : x / y * 100; });
    }
    return (annual.years || []).map((_, i) => num(annual[key]?.[i]));
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

  function profile(stock, sector, company) {
    const tile = (label, value, sub = '') => `<div class="cp-fact"><span class="cp-label">${label}</span><span class="cp-year" style="font-size:22px">${value}</span>${sub ? `<span class="cp-ago">${sub}</span>` : ''}</div>`;
    const weight = stock.shariahWeight != null ? `${f2.format(stock.shariahWeight)}%` : '—';
    const employees = num(company?.employees) ? f0.format(company.employees) : '—';
    return `<div class="cp-head"><h3 id="cp-title">نبذة عن الشركة</h3><div class="cp-tags"><span class="cp-tag">الاسم: ${esc(stock.nameEn || '')}</span><span class="cp-tag market">${esc(stock.exchange || '')}</span></div></div>
      <div class="cp-body">
        <div class="cp-activity"><span class="cp-label">مجال العمل</span><p>${esc(sector.name)}${stock.industry ? ` · ${esc(stock.industry)}` : ''}</p><p class="cp-official">${esc(stock.nameEn || '')} (${esc(stock.symbol)}) · مدرجة في ${esc(stock.exchange || 'السوق الأمريكي')} وضمن قائمة الشركات الشرعية.</p></div>
        <div class="cp-facts">
          ${tile('الوزن في صندوق SPUS', weight, 'حسب آخر حيازات معلنة')}
          ${tile('عدد الموظفين', employees, 'آخر سنة مالية')}
          ${tile('معامل بيتا (5 سنوات)', num(company?.beta) == null ? '—' : f2.format(company.beta), 'تذبذب السهم مقابل السوق')}
        </div>
      </div>`;
  }

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

  function table(company) {
    const years = company?.annual?.years || [];
    if (!years.length) { $('bank-table-wrap').innerHTML = '<p class="financial-status">لا تتوفر نتائج سنوية لهذه الشركة في المصدر.</p>'; return; }
    const shown = years.slice(0, 5);
    const order = shown.map((y, i) => i).reverse(); // الأقدم أولًا ثم الأحدث (يمين → يسار في العرض العربي)
    const head = `<tr><th class="annual-label annual-col-label" scope="col">البند</th>${order.map(i => `<th class="annual-col-value" scope="col">${years[i]}</th><th class="annual-col-change annual-change-heading" scope="col">التغير</th>`).join('')}</tr>`;
    const rows = METRICS.map(([key, label, kind]) => {
      const s = series(company, key);
      if (s.slice(0, 5).every(v => v == null)) return '';
      return `<tr data-metric="${key}"><th class="annual-label" scope="row">${esc(label)}<small>${kind === 'money' ? 'مليون دولار' : kind === 'ps' ? 'دولار للسهم' : 'نسبة مئوية'}</small></th>${order.map(i => `<td class="annual-value">${fmt(s[i], kind)}</td><td class="annual-change">${change(s[i], s[i + 1] ?? null, kind)}</td>`).join('')}</tr>`;
    }).join('');
    $('bank-table-wrap').innerHTML = `<table class="annual-table"><caption class="sr-only">النتائج المالية السنوية</caption><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  function bars(company) {
    const metric = METRICS.find(m => m[0] === state.metric) || METRICS[3];
    const s = series(company, metric[0]);
    const years = company?.annual?.years || [];
    const idx = years.slice(0, 5).map((_, i) => i).reverse().filter(i => s[i] != null);
    $('bank-charts-context').textContent = `${metric[1]} · ${metric[2] === 'money' ? 'مليون دولار' : metric[2] === 'ps' ? 'دولار للسهم' : 'نسبة مئوية'} · سنوي`;
    if (!idx.length) { $('bank-charts-grid').innerHTML = '<p class="financial-status">لا تتوفر بيانات لهذا البند.</p>'; return; }
    const vals = idx.map(i => metric[2] === 'money' ? s[i] / 1e6 : s[i]);
    const max = Math.max(0, ...vals), min = Math.min(0, ...vals), span = max - min || 1;
    const W = 560, H = 240, pad = 34, bw = Math.min(70, (W - pad * 2) / idx.length - 16), y = v => pad + (max - v) / span * (H - pad * 2);
    const gap = (W - pad * 2) / idx.length;
    const out = idx.map((i, k) => {
      const v = vals[k], x = pad + gap * k + (gap - bw) / 2, top = y(Math.max(v, 0)), h = Math.abs(y(v) - y(0));
      const color = v < 0 ? 'var(--red)' : 'var(--teal)';
      return `<g><rect x="${x}" y="${top}" width="${bw}" height="${Math.max(h, 1)}" rx="3" fill="${color}"><title>${years[i]}: ${plain(s[i], metric[2])}</title></rect><text x="${x + bw / 2}" y="${v < 0 ? top + h + 14 : top - 6}" text-anchor="middle" font-size="12" fill="currentColor">${metric[2] === 'money' ? f0.format(v) : f2.format(v)}${metric[2] === 'pct' ? '%' : ''}</text><text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="12" fill="currentColor" opacity=".7">${years[i]}</text></g>`;
    }).join('');
    $('bank-charts-grid').innerHTML = `<div class="bank-chart-card" style="padding:12px"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(metric[1])}" style="width:100%;height:auto;max-height:320px;direction:ltr"><line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" stroke="currentColor" opacity=".25"/>${out}</svg></div>`;
  }

  function show(symbol, { push = true } = {}) {
    const sector = state.data.sectors.find(s => s.stocks.some(x => x.symbol === symbol));
    const stock = sector?.stocks.find(x => x.symbol === symbol);
    if (!stock) { $('bank-load-status').textContent = 'لا توجد شركة بهذا الرمز في القائمة الشرعية.'; return; }
    state.symbol = symbol;
    const company = state.fin.companies[symbol];
    write('us-halal-results-symbol', symbol);
    if (push) { try { history.replaceState(null, '', `company.html?symbol=${encodeURIComponent(symbol)}`); } catch { /* ignore */ } }
    document.title = `${stock.name} | النتائج السنوية | السوق الأمريكي الشرعي`;
    $('crumb').textContent = `نتائج ${sector.name}`;
    $('bank-title').innerHTML = `${esc(stock.name)} <span class="symbol-badge">${esc(symbol)}</span>`;
    const years = company?.annual?.years || [];
    $('bank-period-badge').innerHTML = years.length ? `آخر ${Math.min(5, years.length)} سنوات مالية <bdi>${years[Math.min(4, years.length - 1)]}–${years[0]}</bdi>` : '';
    $('company-profile').innerHTML = profile(stock, sector, company);
    $('unit-note').textContent = 'المبالغ بمليون دولار أمريكي ما لم يُذكر غير ذلك، والسنة المالية قد تنتهي في غير ديسمبر. التغير سنوي مقارنة بالسنة السابقة، وللنسب بالنقاط المئوية. المصدر: TradingView.';
    keyFigures(company);
    table(company);
    bars(company);
    $('bank-load-status').hidden = true;
    $('bank-panel').hidden = false;
    state.sync?.(symbol);
  }

  async function start() {
    try {
      const [data, fin] = await Promise.all([fetch('data.json').then(r => r.json()), fetch('financials.json').then(r => r.json())]);
      state.data = data; state.fin = fin;
    } catch (error) { $('bank-load-status').textContent = 'تعذر تحميل بيانات الشركات.'; return; }
    pickers();
    const sel = $('bank-chart-metric');
    sel.innerHTML = METRICS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
    sel.value = state.metric;
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
