// صفحة «المحفظة»: ملخص + منحنى القيمة مقابل مؤشر S&P 500 + المراكز + الأداء اليومي + سجل الصفقات.
// الأداء اليومي يُعاد حسابه من الصفقات وشموع الإغلاق (ohlc/)، فلا يضيع يوم لم تفتح فيه الموقع؛ آخر نقطة لحظية إن توفر الوسيط.
(() => {
  const P = window.Portfolio;
  const root = document.getElementById('pf-root');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const f2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const f4 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
  const money = n => `${n < 0 ? '-' : ''}$${f2.format(Math.abs(n))}`;
  const signed = n => `${n > 0 ? '+' : n < 0 ? '-' : ''}$${f2.format(Math.abs(n))}`;
  const pct = n => n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${f2.format(n)}%`;
  const cls = n => n > 0 ? 'pf-up' : n < 0 ? 'pf-down' : '';
  const BENCH = 'SPX';

  const S = { snap: null, candles: new Map(), quotes: new Map(), showAllDays: false, ready: false, tab: 'days' };

  // ---------- الشموع ----------
  async function loadCandles(symbol, from) {
    if (S.candles.has(symbol)) return S.candles.get(symbol);
    const promise = (async () => {
      const get = async url => { try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? r.json() : null; } catch { return null; } };
      const recent = await get(`ohlc/${encodeURIComponent(symbol)}.json`);
      if (!recent?.d?.length) return null;
      let d = recent.d, c = recent.c;
      if (recent.historyThrough && from && from < recent.d[0]) {
        const h = await get(`ohlc/history/${encodeURIComponent(symbol)}.json`);
        if (h?.d?.length) { const keep = h.d.map(x => x < recent.d[0]); d = [...h.d.filter((_, i) => keep[i]), ...recent.d]; c = [...h.c.filter((_, i) => keep[i]), ...recent.c]; }
      }
      return { d, c };
    })();
    S.candles.set(symbol, promise);
    return promise;
  }
  // آخر إغلاق بتاريخ ≤ date
  function closeAt(series, date) {
    if (!series) return null;
    let lo = 0, hi = series.d.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (series.d[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans < 0 ? null : series.c[ans];
  }

  // ---------- الأسعار الحالية ----------
  const stockMap = () => new Map((S.snap?.sectors || []).flatMap(s => s.stocks).map(s => [s.symbol, s]));
  function priceNow(symbol) {
    const q = S.quotes.get(symbol);
    if (q?.price > 0) return { price: q.price, pct: q.pct, live: q.status && q.status !== 'Closed' };
    const s = stockMap().get(symbol);
    return { price: s?.price ?? null, pct: s?.day ?? null, live: false };
  }
  function todayDate() {
    const lq = window.LiveQuotes;
    for (const q of S.quotes.values()) { const d = lq?.dateOf?.(q); if (d) return d; }
    return S.snap?.asOf || P.etDate();
  }

  // آخر إغلاق بتاريخ < date (إغلاق يوم التداول السابق)
  function closeBefore(series, date) {
    if (!series) return null;
    let lo = 0, hi = series.d.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (series.d[mid] < date) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans < 0 ? null : series.c[ans];
  }

  // ---------- الحساب ----------
  async function compute() {
    const state = P.load(), now = P.replay(state);
    const symbols = [...new Set(state.trades.map(t => t.symbol))];
    let [bench] = await Promise.all([loadCandles(BENCH, state.startDate), ...symbols.map(s => loadCandles(s, state.startDate))]);
    // إن تأخر ملف شموع المؤشر عن آخر إغلاق، نكمله من إغلاق المؤشر في data.json (عندما يكون إغلاقًا نهائيًا)
    const m = S.snap?.marketSummary, md = m?.performanceDate || S.snap?.asOf;
    if (bench && m?.mode === 'close' && m.value > 0 && md && md > bench.d.at(-1)) bench = { d: [...bench.d, md], c: [...bench.c, m.value] };
    const series = {};
    for (const s of symbols) series[s] = await loadCandles(s, state.startDate);

    const last = now.positions;
    const holdingsNow = Object.values(last).map(p => ({ ...p, ...priceNow(p.symbol) }));
    const valueNow = holdingsNow.reduce((a, p) => a + (p.price ?? p.avg) * p.shares, 0);
    const equityNow = now.cash + valueNow;
    const today = todayDate();

    // أيام المنحنى: أيام تداول المؤشر من تاريخ البدء، ثم اليوم الحالي إن لم يكن له إغلاق بعد
    // القياس يبدأ من يوم أول صفقة (لا من إنشاء المحفظة)، والمؤشر من إغلاق اليوم السابق له.
    // أيام المنحنى = أيام شموع أسهم المحفظة (لا يتعطل المنحنى إن تأخر ملف المؤشر)، وإغلاق المؤشر يُستعمل حيث يوجد فقط.
    const first = state.trades[0]?.date;
    const dateSet = new Set();
    for (const sym of symbols) for (const d of series[sym]?.d || []) if (first && d >= first) dateSet.add(d);
    for (const d of bench?.d || []) if (first && d >= first && dateSet.size) dateSet.add(d);
    const days = [...dateSet].sort();
    const lastCandle = days.at(-1) || bench?.d?.at(-1) || '';
    if (first && (!days.length || today > lastCandle)) days.push(today);
    const exact = (ser, d) => { if (!ser) return null; const i = ser.d.indexOf(d); return i < 0 ? null : ser.c[i]; };
    const baseBench = first ? closeBefore(bench, first) : null;
    const spy = S.quotes.get('SPY');
    const prevSession = days.length > 1 ? days.at(-2) : (lastCandle < today ? lastCandle : null);
    // مؤشر اليوم: إغلاق الجلسة السابقة × حركة SPY اللحظية، ولا يُحسب إن لم يتوفر إغلاق المؤشر لتلك الجلسة
    const prevBenchClose = prevSession ? exact(bench, prevSession) : null;
    const benchToday = baseBench && prevBenchClose && spy?.pct != null ? prevBenchClose * (1 + spy.pct / 100) : null;

    const points = [{ date: first || state.startDate, label: 'البداية', equity: state.startCash, bench: state.startCash, start: true }];
    if (!first) points.push({ date: today, label: today, equity: state.startCash, bench: state.startCash, today: true });
    for (const d of days) {
      const st = P.replay(state, d);
      const isToday = d === today && d > lastCandle;
      let value = 0;
      for (const p of Object.values(st.positions)) {
        const px = isToday ? (priceNow(p.symbol).price ?? closeAt(series[p.symbol], d)) : (closeAt(series[p.symbol], d) ?? priceNow(p.symbol).price);
        value += (px ?? p.avg) * p.shares;
      }
      const b = isToday ? benchToday : exact(bench, d);
      points.push({ date: d, label: d, equity: st.cash + value, bench: baseBench && b ? state.startCash * b / baseBench : null, today: isToday });
    }
    // آخر نقطة = القيمة الحالية بالأسعار الأحدث
    if (points.length > 1) points.at(-1).equity = equityNow;
    if (!first) points.pop(); // محفظة بلا صفقات: لا أداء ولا مقارنة

    const rows = points.slice(1).map((p, i) => {
      const prev = points[i], change = p.equity - prev.equity;
      const bp = p.bench != null && prev.bench ? (p.bench / prev.bench - 1) * 100 : null;
      return { ...p, change, pct: prev.equity ? change / prev.equity * 100 : 0, benchPct: bp };
    });
    let peak = -Infinity, maxDd = 0;
    for (const p of points) { peak = Math.max(peak, p.equity); maxDd = Math.min(maxDd, (p.equity / peak - 1) * 100); }
    const traded = rows.filter(r => r.change !== 0);
    const best = traded.length ? traded.reduce((a, b) => b.pct > a.pct ? b : a) : null, worst = traded.length ? traded.reduce((a, b) => b.pct < a.pct ? b : a) : null;
    const costNow = holdingsNow.reduce((a, p) => a + p.cost, 0);
    const prevEq = points.length > 1 ? points.at(-2).equity : state.startCash;
    const benchEnd = first ? points.at(-1).bench : null; // null إن تأخر إغلاق المؤشر لآخر يوم
    return {
      state, now, holdings: holdingsNow, equityNow, valueNow, points, rows, maxDd, best, worst,
      totalPL: equityNow - state.startCash, totalPct: (equityNow / state.startCash - 1) * 100,
      dayPL: equityNow - prevEq, dayPct: prevEq ? (equityNow / prevEq - 1) * 100 : 0,
      unrealized: valueNow - costNow, benchPct: benchEnd ? (benchEnd / state.startCash - 1) * 100 : null
    };
  }

  // ---------- الرسم ----------
  function chartSvg(points) {
    const W = 900, H = 300, L = 62, R = 14, T = 14, B = 30;
    const eq = points.map(p => p.equity), bn = points.map(p => p.bench).filter(v => v != null);
    const all = [...eq, ...bn], lo0 = Math.min(...all), hi0 = Math.max(...all), pad = (hi0 - lo0) * 0.12 || hi0 * 0.01 || 1;
    const lo = lo0 - pad, hi = hi0 + pad, n = points.length;
    const x = i => L + (n === 1 ? 0.5 : i / (n - 1)) * (W - L - R), y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const path = key => points.map((p, i) => p[key] == null ? '' : `${points.slice(0, i).some(q => q[key] != null) ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join('');
    const ticks = [0, 1, 2, 3, 4].map(k => lo + (hi - lo) * k / 4);
    const grid = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="currentColor" opacity=".12"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="currentColor" opacity=".65">${f0.format(v)}</text>`).join('');
    const xs = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i).map(i => `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" font-size="11" fill="currentColor" opacity=".65">${esc(points[i].label)}</text>`).join('');
    const base = `<line x1="${L}" x2="${W - R}" y1="${y(points[0].equity)}" y2="${y(points[0].equity)}" stroke="currentColor" opacity=".35" stroke-dasharray="4 4"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="منحنى قيمة المحفظة مقابل مؤشر S&P 500"><g>${grid}${base}${xs}</g>
      <path d="${path('bench')}" fill="none" stroke="#5aa0ff" stroke-width="2" opacity=".9"/>
      <path d="${path('equity')}" fill="none" stroke="var(--teal)" stroke-width="2.6"/>
      <circle cx="${x(n - 1)}" cy="${y(points[n - 1].equity)}" r="4" fill="var(--teal)"/>
      <line data-pf-cross y1="${T}" y2="${H - B}" stroke="currentColor" opacity=".35" visibility="hidden"/></svg>`;
  }

  // ---------- الواجهة ----------
  function render(c) {
    const e = c.state.trades.length === 0;
    const rowsDays = [...c.rows].reverse(), shownDays = S.showAllDays ? rowsDays : rowsDays.slice(0, 15);
    const trades = [...c.state.trades].reverse();
    const winRate = c.now.sells ? `${f0.format(c.now.wins / c.now.sells * 100)}%` : '—';
    const live = window.LiveQuotes?.enabled && window.LiveQuotes.isExtendedHours();
    root.innerHTML = `
      <div class="pf-title">
        <div><h2>المحفظة الافتراضية</h2><p>رصيد ابتدائي ${money(c.state.startCash)} منذ ${esc(c.state.startDate)} · تداول افتراضي بآخر سعر ${live ? '<span class="pf-up">● لحظي</span>' : '(آخر سعر متاح)'} · بلا عمولات</p></div>
        <div class="pf-actions"><button class="pf-btn primary" data-pf-trade="buy">+ تداول سهم</button><button class="pf-btn" data-pf-export>تصدير نسخة احتياطية</button><button class="pf-btn" data-pf-import>استيراد</button><button class="pf-btn danger" data-pf-reset>إعادة ضبط</button><input type="file" accept="application/json" data-pf-file hidden></div>
      </div>
      <div class="pf-cards">
        <div class="pf-card"><span>القيمة الإجمالية</span><b>${money(c.equityNow)}</b><small>أسهم ${money(c.valueNow)} + نقد ${money(c.now.cash)}</small></div>
        <div class="pf-card"><span>أداء اليوم</span><b class="${cls(c.dayPL)}">${signed(c.dayPL)}</b><small class="${cls(c.dayPL)}">${pct(c.dayPct)}</small></div>
        <div class="pf-card"><span>العائد الكلي</span><b class="${cls(c.totalPL)}">${signed(c.totalPL)}</b><small class="${cls(c.totalPL)}">${pct(c.totalPct)}</small></div>
        <div class="pf-card"><span>مقابل S&amp;P 500</span><b class="${cls(c.benchPct == null ? 0 : c.totalPct - c.benchPct)}">${c.benchPct == null ? '—' : `${c.totalPct - c.benchPct > 0 ? '+' : ''}${f2.format(c.totalPct - c.benchPct)} ن.م.`}</b><small>المؤشر ${pct(c.benchPct)} · المحفظة ${pct(c.totalPct)}</small></div>
        <div class="pf-card"><span>النقد المتاح</span><b>${money(c.now.cash)}</b><small>${f2.format(c.equityNow ? c.now.cash / c.equityNow * 100 : 100)}% من المحفظة</small></div>
      </div>
      <section class="pf-panel"><h3>منحنى القيمة <span class="pf-legend"><span><i style="background:var(--teal)"></i>المحفظة</span><span><i style="background:#5aa0ff"></i>مؤشر S&amp;P 500 (بنفس رأس المال)</span></span></h3>
        <div class="pf-chart" data-pf-chart>${chartSvg(c.points)}<div class="pf-tip" hidden></div></div>
        ${e ? '<p class="pf-empty-state">لم تنفّذ أي صفقة بعد. اضغط «+ تداول سهم» أو افتح شارت أي سهم واستخدم زر «شراء». يبدأ منحنى الأداء ويُحسب يوميًا بعد أول صفقة.</p>' : ''}
      </section>
      <section class="pf-panel"><h3>المراكز المفتوحة <small>${c.holdings.length} مركز</small></h3>${positionsTable(c)}</section>
      <section class="pf-panel"><h3>الأداء اليومي <small>التغير اليومي لقيمة المحفظة مقابل المؤشر</small></h3>${daysTable(shownDays, rowsDays.length)}
        <div class="pf-cards" style="margin-top:12px">
          <div class="pf-card"><span>أفضل يوم</span><b class="${cls(c.best?.pct)}">${c.best ? pct(c.best.pct) : '—'}</b><small>${c.best ? esc(c.best.date) : ''}</small></div>
          <div class="pf-card"><span>أسوأ يوم</span><b class="${cls(c.worst?.pct)}">${c.worst ? pct(c.worst.pct) : '—'}</b><small>${c.worst ? esc(c.worst.date) : ''}</small></div>
          <div class="pf-card"><span>أقصى تراجع</span><b class="${cls(c.maxDd)}">${pct(c.maxDd)}</b><small>من أعلى قيمة بلغتها</small></div>
          <div class="pf-card"><span>ربح محقق</span><b class="${cls(c.now.realized)}">${signed(c.now.realized)}</b><small>نسبة الصفقات الرابحة ${winRate}</small></div>
          <div class="pf-card"><span>ربح غير محقق</span><b class="${cls(c.unrealized)}">${signed(c.unrealized)}</b><small>${c.state.trades.length} صفقة</small></div>
        </div>
      </section>
      <section class="pf-panel"><h3>سجل الصفقات <small>${trades.length} صفقة</small></h3>${tradesTable(trades)}</section>
      <p class="pf-note-box">المحفظة افتراضية بالكامل ومحفوظة في هذا المتصفح فقط (احتفظ بنسخة احتياطية عبر «تصدير»). تُنفَّذ الأوامر بآخر سعر متاح بلا عمولات ولا انزلاق ولا ضرائب، وليست توصية استثمارية. الأداء اليومي يُحسب من أسعار الإغلاق، واليوم الحالي بالسعر الأحدث. أداء المؤشر لنفس رأس المال من إغلاق اليوم السابق لأول صفقة.</p>`;
    bindChart(c);
  }
  const sym = (p) => `<span class="sym"><img class="co-logo co-logo-sm" src="logos/${esc(p.symbol)}.svg" alt="" onerror="this.remove()"><a href="company.html?symbol=${encodeURIComponent(p.symbol)}">${esc(p.name || p.symbol)}</a><bdi class="symbol-badge">${esc(p.symbol)}</bdi></span>`;
  function positionsTable(c) {
    if (!c.holdings.length) return '<p class="pf-empty-state">لا توجد مراكز مفتوحة.</p>';
    const rows = [...c.holdings].sort((a, b) => b.shares * (b.price ?? b.avg) - a.shares * (a.price ?? a.avg)).map(p => {
      const px = p.price ?? p.avg, val = px * p.shares, pl = val - p.cost, plp = p.cost ? pl / p.cost * 100 : 0;
      return `<tr><td>${sym(p)}</td><td class="pf-n">${f4.format(p.shares)}</td><td class="pf-n">${f2.format(p.avg)}</td><td class="pf-n">${p.price == null ? '—' : f2.format(p.price)}${p.live ? ' <span class="pf-up" title="سعر لحظي">●</span>' : ''}</td><td class="pf-n ${cls(p.pct)}">${pct(p.pct)}</td><td class="pf-n">${money(val)}</td><td class="pf-n ${cls(pl)}">${signed(pl)}</td><td class="pf-n ${cls(pl)}">${pct(plp)}</td><td class="pf-n">${f2.format(c.equityNow ? val / c.equityNow * 100 : 0)}%</td><td><button class="pf-mini buy" data-pf-trade="buy" data-pf-symbol="${esc(p.symbol)}">شراء</button> <button class="pf-mini sell" data-pf-trade="sell" data-pf-symbol="${esc(p.symbol)}">بيع</button></td></tr>`;
    }).join('');
    return `<div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>السهم</th><th class="pf-n">الكمية</th><th class="pf-n">متوسط التكلفة</th><th class="pf-n">آخر سعر</th><th class="pf-n">تغير اليوم</th><th class="pf-n">القيمة</th><th class="pf-n">الربح/الخسارة</th><th class="pf-n">%</th><th class="pf-n">الوزن</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function daysTable(rows, total) {
    if (!rows.length) return '<p class="pf-empty-state">يظهر الأداء اليومي بعد أول جلسة تداول بعد الصفقة الأولى.</p>';
    const body = rows.map(r => `<tr><td>${esc(r.date)}${r.today ? ' <small class="pf-up">اليوم</small>' : ''}</td><td class="pf-n">${money(r.equity)}</td><td class="pf-n ${cls(r.change)}">${signed(r.change)}</td><td class="pf-n ${cls(r.pct)}">${pct(r.pct)}</td><td class="pf-n ${cls(r.benchPct)}">${pct(r.benchPct)}</td><td class="pf-n ${cls(r.benchPct == null ? 0 : r.pct - r.benchPct)}">${r.benchPct == null ? '—' : `${r.pct - r.benchPct > 0 ? '+' : ''}${f2.format(r.pct - r.benchPct)}`}</td></tr>`).join('');
    return `<div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>التاريخ</th><th class="pf-n">قيمة المحفظة</th><th class="pf-n">التغير ($)</th><th class="pf-n">التغير (%)</th><th class="pf-n">S&amp;P 500 (%)</th><th class="pf-n">الفرق (ن.م.)</th></tr></thead><tbody>${body}</tbody></table></div>${total > rows.length ? `<p style="text-align:center;margin:10px 0 0"><button class="pf-btn" data-pf-days>عرض كل الأيام (${total})</button></p>` : S.showAllDays && total > 15 ? '<p style="text-align:center;margin:10px 0 0"><button class="pf-btn" data-pf-days>عرض أقل</button></p>' : ''}`;
  }
  function tradesTable(trades) {
    if (!trades.length) return '<p class="pf-empty-state">لا توجد صفقات بعد.</p>';
    const rows = trades.map(t => `<tr><td>${esc(t.t.slice(0, 16).replace('T', ' '))}</td><td><b class="${t.side === 'buy' ? 'pf-up' : 'pf-down'}">${t.side === 'buy' ? 'شراء' : 'بيع'}</b></td><td>${sym(t)}</td><td class="pf-n">${f4.format(t.qty)}</td><td class="pf-n">${f2.format(t.price)}</td><td class="pf-n">${money(t.total)}</td><td class="pf-n ${cls(t.realized)}">${t.side === 'sell' && t.realized != null ? signed(t.realized) : '—'}</td></tr>`).join('');
    return `<div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>الوقت (UTC)</th><th>النوع</th><th>السهم</th><th class="pf-n">الكمية</th><th class="pf-n">السعر</th><th class="pf-n">الإجمالي</th><th class="pf-n">ربح محقق</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function bindChart(c) {
    const box = root.querySelector('[data-pf-chart]'); if (!box) return;
    const svg = box.querySelector('svg'), tip = box.querySelector('.pf-tip'), cross = svg.querySelector('[data-pf-cross]'), n = c.points.length;
    const L = 62, R = 14, W = 900;
    box.addEventListener('pointermove', ev => {
      const r = svg.getBoundingClientRect(), vx = (ev.clientX - r.left) / r.width * W;
      const i = Math.max(0, Math.min(n - 1, Math.round((vx - L) / (W - L - R) * (n - 1)))), p = c.points[i], prev = c.points[i - 1];
      const xx = L + (n === 1 ? 0.5 : i / (n - 1)) * (W - L - R);
      cross.setAttribute('x1', xx); cross.setAttribute('x2', xx); cross.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = `<b>${esc(p.label)}</b><br>المحفظة: ${money(p.equity)}${prev ? ` (<span class="${cls(p.equity - prev.equity)}">${signed(p.equity - prev.equity)}</span>)` : ''}<br>S&amp;P 500: ${p.bench == null ? '—' : money(p.bench)}`;
    });
    box.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  }

  // ---------- أزرار الصفحة ----------
  root.addEventListener('click', ev => {
    if (ev.target.closest('[data-pf-days]')) { S.showAllDays = !S.showAllDays; refresh(); return; }
    if (ev.target.closest('[data-pf-export]')) {
      const blob = new Blob([JSON.stringify(P.load(), null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `us-halal-portfolio-${P.etDate()}.json` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); return;
    }
    if (ev.target.closest('[data-pf-import]')) { S.picking = true; root.querySelector('[data-pf-file]').click(); setTimeout(() => { S.picking = false; }, 60000); return; }
    if (ev.target.closest('[data-pf-reset]')) {
      if (confirm('سيُحذف كل شيء (الصفقات والأداء) وتبدأ محفظة جديدة بـ 10,000$. تأكد أنك صدّرت نسخة احتياطية إن أردت. متابعة؟')) { P.save(P.fresh()); }
    }
  });
  root.addEventListener('change', async ev => {
    S.picking = false; const input = ev.target.closest('[data-pf-file]'); if (!input?.files?.[0]) return;
    try {
      const s = JSON.parse(await input.files[0].text());
      if (!s || !Array.isArray(s.trades) || !Number.isFinite(s.startCash) || !s.startDate || s.trades.some(t => !t.symbol || !(t.qty > 0) || !(t.price > 0) || !['buy', 'sell'].includes(t.side) || !t.date)) throw new Error('bad');
      if (confirm(`استيراد محفظة فيها ${s.trades.length} صفقة؟ ستُستبدل المحفظة الحالية.`)) P.save({ ...s, v: 1 });
    } catch { alert('الملف غير صالح: يجب أن يكون نسخة احتياطية مُصدَّرة من هذه الصفحة.'); }
  });

  // ---------- الدورة ----------
  let busy = false, timer = null;
  async function refresh() {
    if (busy) return; busy = true;
    try {
      if (!S.snap) S.snap = await P.snapshot();
      const held = [...new Set(P.load().trades.map(t => t.symbol))];
      const lq = window.LiveQuotes;
      if (lq?.enabled && !document.hidden) for (const [k, v] of await lq.quotes([...held, 'SPY'])) S.quotes.set(k, v);
      render(await compute());
      S.ready = true;
    } catch (error) { root.innerHTML = `<p class="financial-status">تعذر تحميل المحفظة: ${esc(error.message || error)}</p>`; }
    finally { busy = false; }
  }
  function schedule() {
    clearTimeout(timer);
    const lq = window.LiveQuotes;
    timer = setTimeout(async () => { if (!document.hidden && !S.picking && !document.querySelector('.pf-overlay')) await refresh(); schedule(); }, lq?.enabled && lq.isExtendedHours() ? 3000 : 60000);
  }
  window.addEventListener('portfolio:change', () => refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  const start = () => refresh().then(schedule);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
