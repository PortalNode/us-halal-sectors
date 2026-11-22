// بطاقة «السهم»: سعر السهم وتغيره اليومي وربحيته ومكرراته وعائد التوزيع، وإلى يسارها شارت صغير بمدد متعددة
// (الشارت الكامل في صفحة التحليل الفني technical-analysis.html).
// تظهر تحت «نبذة عن الشركة» (أو تحت عنوان الشركة إن لم تكن لها نبذة) في صفحات النتائج.
// تقرأ الرمز من شارة .symbol-badge في العنوان، فتتحدث تلقائيًا عند التنقل بين الشركات.
// الأسعار من data.json (إغلاق تداول الرسمي)، والربحية والقيمة الدفترية من financial-map.json كما في الصفحة الرئيسية،
// والشموع اليومية من ohlc/<الرمز>.json.
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const f2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt = value => value == null ? '—' : f2.format(value);
  const dotDate = iso => iso ? iso.split('-').reverse().join('.') : '';

  // مدد الشارت الصغير، بالنفس الخيارات المعروضة في الشارت الكامل (يوم وأيام وأشهر وسنوات والكل)
  // months: عدد الأشهر إلى الوراء من آخر جلسة؛ days: عدد الجلسات؛ all: كامل الملف
  const MINI_RANGES = [
    { id: '1d', label: 'يوم', sessions: 1 },
    { id: '5d', label: '5 أيام', sessions: 5 },
    { id: '3m', label: '3 أشهر', months: 3 },
    { id: '6m', label: '6 أشهر', months: 6 },
    { id: '1y', label: 'سنة', months: 12 },
    { id: '2y', label: 'سنتين', months: 24 },
    { id: '5y', label: '5 سنوات', months: 60 },
    { id: 'all', label: 'الكل' }
  ];
  let miniRange = '1y'; // يبقى المختار عند التنقل بين الشركات

  // الصناديق العقارية تُتداول بالوحدات لا بالأسهم
  const UNIT = 'السهم';
  let stocks = null, financials = null, shown = null;
  const candleCache = new Map();

  /* ---------- الأرقام ---------- */
  function figures(stock) {
    // الربحية المخففة لآخر 12 شهرًا (TTM) من data.json، كما في الصفحة الرئيسية
    const eps = num(stock.epsDiluted) ?? num(stock.eps);
    const price = num(stock.price), book = num(stock.bookValue);
    const pe = eps > 0 && price > 0 ? price / eps : null;
    const day = num(stock.day), dir = day > 0 ? 'up' : day < 0 ? 'down' : 'flat';
    // بلا سطر تعليق تحت الأرقام؛ التاريخ والمصدر في وسم رأس الصندوق
    const tile = (label, value, unit, cls = '') => `<div class="cq-tile ${cls}"><span class="cq-label">${label}</span><span class="cq-value"><bdi>${value}</bdi>${unit ? `<small>${unit}</small>` : ''}</span></div>`;
    return [
      tile(`سعر ${UNIT}`, fmt(price), '$', 'cq-price'),
      tile('التغير اليومي', day == null ? '—' : `${day > 0 ? '▲' : day < 0 ? '▼' : ''} ${f2.format(Math.abs(day))}%`, '', `cq-${dir}`),
      tile(`ربح ${UNIT}`, fmt(eps), '$'),
      tile('مكرر الأرباح', pe == null ? (eps != null && eps <= 0 ? 'سالب' : '—') : fmt(pe), pe == null ? '' : 'مرة'),
      tile('القيمة الدفترية', fmt(book), '$'),
      tile('عائد التوزيع', num(stock.dividendYield) == null ? '—' : `${f2.format(stock.dividendYield)}%`, '')
    ].join('');
  }

  async function loadCandles(symbol) {
    // الملف الأخير وملف التاريخ معًا (company-chart.js)؛ تتغير يوميًا فلا تُؤخذ من ذاكرة المتصفح
    if (!candleCache.has(symbol)) candleCache.set(symbol, window.CompanyChart?.load ? window.CompanyChart.load(symbol)
      : fetch(`ohlc/${encodeURIComponent(symbol)}.json`, { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).then(d => d?.d?.length > 1 ? d : null).catch(() => null));
    return candleCache.get(symbol);
  }

  // أسعار اليوم والخمسة أيام كل 5 دقائق (intraday/<الرمز>.json)، تُحدَّث مع التحديث الدوري للأسعار
  const intradayCache = new Map();
  const loadIntraday = symbol => {
    if (!intradayCache.has(symbol)) intradayCache.set(symbol, fetch(`intraday/${encodeURIComponent(symbol)}.json`, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : null).then(d => d?.t?.length > 1 ? d : null).catch(() => null));
    return intradayCache.get(symbol);
  };
  // توقيت نيويورك للفترات الداخلية: «YYYY-MM-DD» و«HH:MM»
  const NY_PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const riyadh = epoch => { const p = Object.fromEntries(NY_PARTS.formatToParts(new Date(epoch * 1000)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };

  // جلسة اليوم (أو آخر جلسة) من وسيط الأسعار اللحظية: صفقات ناسداك دقيقة بدقيقة، تُستخدم لشارت «يوم» حين لا يوجد ملف intraday
  const sessionCache = new Map();
  const loadSession = symbol => {
    const lq = window.LiveQuotes;
    if (!lq?.enabled) return Promise.resolve(null);
    // لا يُحفظ الفشل: تعاد المحاولة عند فتح الشركة مرة أخرى
    if (!sessionCache.has(symbol)) sessionCache.set(symbol, Promise.resolve(lq.session(symbol)).then(d => d?.ticks?.length > 1 ? d : null).catch(() => null)
      .then(d => { if (!d) sessionCache.delete(symbol); return d; }));
    return sessionCache.get(symbol);
  };
  // صفقات الجلسة العادية (9:30 – 16:00 بتوقيت نيويورك) مجمّعة في شموع 5 دقائق.
  // ختم الوقت عند ناسداك هو توقيت نيويورك الجداري مكتوبًا كأنه UTC، فيُقرأ بـ UTC مباشرة.
  function sessionPoints(session) {
    if (!session?.ticks?.length || !session.date) return [];
    const buckets = new Map();
    for (const [ms, price] of session.ticks) {
      const iso = new Date(ms).toISOString(), day = iso.slice(0, 10), minutes = +iso.slice(11, 13) * 60 + +iso.slice(14, 16);
      if (day !== session.date || minutes < 570 || minutes > 960 || !(price > 0)) continue;
      const slot = Math.min(955, Math.floor(minutes / 5) * 5);
      const b = buckets.get(slot);
      if (b) { b.h = Math.max(b.h, price); b.l = Math.min(b.l, price); b.c = price; }
      else buckets.set(slot, { o: price, h: price, l: price, c: price, day, hm: `${String(Math.floor(slot / 60)).padStart(2, '0')}:${String(slot % 60).padStart(2, '0')}` });
    }
    const points = [...buckets.keys()].sort((a, b) => a - b).map(k => buckets.get(k));
    // آخر نقطة = آخر سعر للجلسة (سعر الإغلاق الرسمي بعد المزاد، أو آخر صفقة أثناء الجلسة) ليطابق بطاقة السعر
    const last = points.at(-1), close = num(session.close);
    if (last && close > 0) { last.c = close; last.h = Math.max(last.h, close); last.l = Math.min(last.l, close); }
    return points;
  }

  const MINI_EMPTY = '<p class="cq-empty cq-mini-empty">لا تتوفر شموع لهذا السهم بعد.</p>';
  const dmy = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

  // سلسلة الشارت الصغير: للمدد الطويلة شموع يومية معدلة للتوزيعات (كما في ADJ)، وليوم وخمسة أيام شموع 5 دقائق
  function miniSeries(file, rangeId, intraday, session) {
    const calc = window.CompanyChart?.calc;
    if (!calc || !file?.d?.length || file.d.length !== file.c?.length) return null;
    const raw = file.d.map((time, i) => {
      const close = file.c[i];
      return { time, open: file.o?.[i] ?? close, high: file.h?.[i] ?? close, low: file.l?.[i] ?? close, close };
    });
    const dividends = (file.div || []).filter(([d]) => d > raw[0].time && d <= raw.at(-1).time);
    const bars = calc.adjustDividends(raw, dividends);
    const range = MINI_RANGES.find(r => r.id === rangeId) || MINI_RANGES[4];
    let series, base, intra = false;
    // شموع 5 دقائق: من ملف intraday إن وُجد، وإلا جلسة اليوم من الوسيط اللحظي (تكفي لشارت «يوم» فقط)
    let points = intraday?.t?.length > 1 ? intraday.t.map((t, i) => {
      const c = intraday.c[i], iso = riyadh(t);
      return { o: intraday.o?.[i] ?? c, h: intraday.h?.[i] ?? c, l: intraday.l?.[i] ?? c, c, day: iso.slice(0, 10), hm: iso.slice(11, 16) };
    }) : [];
    if (range.sessions === 1 && points.length < 2) points = sessionPoints(session);
    const enoughIntraday = range.sessions && points.length > 1 && new Set(points.map(p => p.day)).size >= range.sessions;
    if (enoughIntraday) {
      // آخر جلسات التداول، ونقطة الأساس إغلاق الجلسة السابقة لأول جلسة معروضة
      const days = [...new Set(points.map(p => p.day))].slice(-range.sessions);
      series = points.filter(p => days.includes(p.day)).map(p => ({ ...p, label: range.sessions === 1 ? p.hm : `${dmy(p.day)} ${p.hm}`, full: `${dmy(p.day)}.${p.day.slice(0, 4)} ${p.hm}`, first: false }));
      series.forEach((p, i) => { p.first = i === 0 || series[i - 1].day !== p.day; });
      const previous = raw.filter(b => b.time < days[0]).at(-1);
      base = previous ? previous.close : num(session?.prevClose) ?? series[0].c;
      intra = true;
    } else if (range.sessions) {
      // بلا شموع دقائق: إغلاقات يومية لآخر الجلسات، تبدأ من إغلاق الجلسة التي قبلها (لا يُعرض التاريخ كله أبدًا)
      let daily = raw;
      if (session?.date && num(session.close) > 0 && session.date > raw.at(-1).time) {
        const c = session.close;
        daily = [...raw, { time: session.date, open: num(session.open) ?? c, high: Math.max(num(session.high) ?? c, c), low: Math.min(num(session.low) ?? c, c), close: c }];
      }
      series = daily.slice(-(range.sessions + 1)).map(b => ({ o: b.open, h: b.high, l: b.low, c: b.close, day: b.time, label: dotDate(b.time), full: dotDate(b.time), first: false }));
      base = series[0]?.c;
    } else {
      let shown = bars;
      if (range.months) {
        const from = new Date(`${bars.at(-1).time}T12:00:00Z`);
        from.setUTCMonth(from.getUTCMonth() - range.months);
        const iso = from.toISOString().slice(0, 10);
        shown = bars.filter(b => b.time >= iso);
      }
      series = shown.map(b => ({ o: b.open, h: b.high, l: b.low, c: b.close, day: b.time, label: dotDate(b.time), full: dotDate(b.time), first: false }));
      base = series[0]?.c;
    }
    if (series.length < 2 || !(base > 0)) return null;
    return { series, base, intra, sessions: range.sessions || 0 };
  }

  // الشارت الصغير: خط مساحي مربع، ومحور أسعار على اليمين، ومحور وقت أسفله، وسطر O H L C يتغير مع المؤشر
  function miniHtml(symbol, rangeId, { series, base, intra, sessions }) {
    const n = series.length, W = 100, H = 100, pad = 4;
    const closes = series.map(p => p.c), min = Math.min(...closes), max = Math.max(...closes), span = max - min || 1;
    const x = i => (i / (n - 1)) * W;
    const y = v => pad + (1 - (v - min) / span) * (H - 2 * pad);
    const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)} ${y(p.c).toFixed(2)}`).join('');
    const last = series[n - 1], change = (last.c - base) / base * 100;
    const dir = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    const yTicks = [0, 1, 2, 3, 4].map(k => { const v = min + span * k / 4; return `<span style="top:${y(v).toFixed(2)}%">${f2.format(v)}</span>`; }).join('');
    // محور الوقت: ساعات كاملة لليوم، وبداية كل يوم للأيام الخمسة، وثلاث علامات للمدد الطويلة
    const ticks = [];
    if (intra && sessions === 1) series.forEach((p, i) => { if (p.hm.endsWith(':00') && i > 0 && i < n - 1) ticks.push([i, p.hm]); });
    else if (intra) series.forEach((p, i) => { if (p.first && i > 0) ticks.push([i, `${dmy(p.day)}`]); });
    else [...new Set([0, Math.round((n - 1) / 2), n - 1])].forEach(i => ticks.push([i, series[i].label]));
    const xTicks = ticks.map(([i, text]) => {
      const cls = i === 0 ? ' class="cq-mini-x-first"' : i === n - 1 ? ' class="cq-mini-x-last"' : '';
      return `<span${cls} style="left:${x(i).toFixed(2)}%">${text}</span>`;
    }).join('');
    const buttons = MINI_RANGES.map(r => `<button type="button" data-mini-range="${r.id}" aria-pressed="${r.id === rangeId}">${r.label}</button>`).join('');
    const link = `technical-analysis.html?symbol=${encodeURIComponent(symbol)}`;
    return `<div class="cq-mini">
        <div class="cq-mini-ranges" role="group" aria-label="مدة الشارت الصغير">${buttons}</div>
        <div class="cq-mini-ohlc" dir="ltr"></div>
        <div class="cq-mini-body" dir="ltr">
          <a class="cq-mini-plot-link" href="${link}" title="فتح التحليل الفني للسهم">
            <span class="cq-mini-plot">
              <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="cq-mini-area" d="${line}L${W} ${H}L0 ${H}Z"/><path class="cq-mini-line" d="${line}"/></svg>
              <i class="cq-mini-dot" style="top:${y(last.c).toFixed(2)}%"></i>
              <i class="cq-mini-cross" hidden></i>
              <i class="cq-mini-hline" hidden></i>
            </span>
          </a>
          <div class="cq-mini-yaxis" aria-hidden="true">${yTicks}<span class="cq-mini-ytag" hidden></span></div>
        </div>
        <div class="cq-mini-xaxis" dir="ltr" aria-hidden="true">${xTicks}<span class="cq-mini-xtag" hidden></span></div>
        <div class="cq-mini-meta">
          <span class="cq-${dir}"><bdi>${change > 0 ? '+' : ''}${f2.format(change)}%</bdi></span>
        </div>
      </div>`;
  }

  // يربط المؤشر بسطر O H L C، وبخط أفقي وشاقولي، وبوسمي السعر على محور الأسعار والتاريخ على محور الوقت (كما في المرجع)
  function bindMini(slot, { series }) {
    const n = series.length, link = slot.querySelector('.cq-mini-plot-link'), legend = slot.querySelector('.cq-mini-ohlc');
    const cross = slot.querySelector('.cq-mini-cross'), hline = slot.querySelector('.cq-mini-hline');
    const ytag = slot.querySelector('.cq-mini-ytag'), xtag = slot.querySelector('.cq-mini-xtag');
    const closes = series.map(p => p.c), min = Math.min(...closes), max = Math.max(...closes), span = max - min || 1;
    const yAt = v => 4 + (1 - (v - min) / span) * 92;
    const show = i => {
      const p = series[i];
      legend.innerHTML = `<span class="cq-mini-when">${esc(p.label)}</span><span>O <bdi>${f2.format(p.o)}</bdi></span><span>H <bdi>${f2.format(p.h)}</bdi></span><span>L <bdi>${f2.format(p.l)}</bdi></span><span>C <bdi>${f2.format(p.c)}</bdi></span>`;
    };
    const hide = () => { cross.hidden = hline.hidden = ytag.hidden = xtag.hidden = true; };
    show(n - 1); hide();
    link.addEventListener('pointermove', event => {
      const r = link.getBoundingClientRect(), f = Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)), i = Math.round(f * (n - 1));
      const p = series[i], xPct = (i / (n - 1)) * 100, yPct = yAt(p.c);
      show(i);
      cross.hidden = hline.hidden = ytag.hidden = xtag.hidden = false;
      cross.style.left = `${xPct}%`;
      hline.style.top = `${yPct}%`;
      ytag.style.top = `${yPct}%`; ytag.textContent = f2.format(p.c);
      xtag.style.left = `${xPct}%`; xtag.textContent = p.full;
      // عند الحافة يبقى الوسم داخل الشارت
      xtag.style.transform = xPct > 75 ? 'translateX(-100%)' : xPct < 25 ? 'none' : 'translateX(-50%)';
    });
    link.addEventListener('pointerleave', () => { hide(); show(n - 1); });
  }

  const tagText = stock => stock.priceStatus === 'realtime' ? `سعر لحظي · ${dotDate(stock.priceDate)} · المصدر: ناسداك (آخر صفقة)`
    : `${(stock.priceStatus === 'close' || stock.priceStatus === 'official_close') ? 'إغلاق الجلسة' : 'سعر متأخر'} · ${dotDate(stock.priceDate)} · المصدر: تريدينغ فيو`;
  // سعر لحظي للسهم المعروض (وسيط Nasdaq): يحدّث بطاقة الأرقام دون إعادة رسم الصفحة
  let liveTimer = null, waiting = null;
  function startLive(symbol, stock, box) {
    clearTimeout(liveTimer);
    const lq = window.LiveQuotes;
    if (!lq?.enabled) return;
    const tick = async () => {
      if (shown !== symbol || !box.isConnected) return;
      if (!document.hidden) {
        const q = (await lq.quotes([symbol])).get(symbol);
        if (q && shown === symbol) {
          stock.price = q.price;
          if (Number.isFinite(q.pct)) stock.day = q.pct;
          stock.priceStatus = q.status === 'Closed' ? 'close' : 'realtime';
          stock.priceDate = lq.dateOf(q) || stock.priceDate;
          const figs = box.querySelector('.cq-figures'), tag = box.querySelector('#cq-tag');
          if (figs) figs.innerHTML = figures(stock);
          if (tag) tag.textContent = tagText(stock);
        }
      }
      liveTimer = setTimeout(tick, lq.isExtendedHours() ? 2000 : 30000);
    };
    tick();
  }

  function card(stock) {
    return `
      <div class="cq-head"><h3 id="cq-title">${UNIT}</h3><div class="cp-tags"><span class="cp-tag" id="cq-tag">${esc(tagText(stock))}</span><span class="pf-trade-btns"><button type="button" class="pf-trade-btn buy" data-pf-trade="buy" data-pf-symbol="${esc(stock.symbol)}">شراء افتراضي</button><button type="button" class="pf-trade-btn sell" data-pf-trade="sell" data-pf-symbol="${esc(stock.symbol)}">بيع</button></span></div></div>
      <div class="cq-body">
        <div class="cq-figures">${figures(stock)}</div>
        <div class="cq-mini-slot"><p class="cq-empty cq-mini-empty">جار تحميل الشارت…</p></div>
      </div>`;
  }

  async function paint() {
    const heading = document.querySelector('.bank-heading');
    const symbol = heading?.querySelector('.symbol-badge')?.textContent.trim();
    if (!stocks || !heading || !symbol || symbol === shown) return;
    const stock = stocks.get(symbol);
    let box = document.getElementById('company-quote');
    if (!stock) { box?.remove(); shown = symbol; return; }
    // أثناء ساعات السوق ننتظر أول سعر لحظي (حتى 3.5 ثانية) بدل عرض إغلاق أمس
    const lq = window.LiveQuotes;
    if (lq?.enabled && lq.isExtendedHours() && !stock._liveFirst) {
      if (waiting === symbol) return;
      waiting = symbol;
      const q = (await Promise.race([lq.quotes([symbol]), new Promise(resolve => setTimeout(() => resolve(null), 3500))]))?.get(symbol);
      waiting = null;
      stock._liveFirst = true;
      if (q) {
        stock.price = q.price;
        if (Number.isFinite(q.pct)) stock.day = q.pct;
        stock.priceStatus = q.status === 'Closed' ? 'close' : 'realtime';
        stock.priceDate = lq.dateOf(q) || stock.priceDate;
      }
      if (document.querySelector('.bank-heading .symbol-badge')?.textContent.trim() !== symbol) return;
    }
    const anchor = document.getElementById('company-profile') || heading;
    if (!box) {
      box = document.createElement('section');
      box.id = 'company-quote';
      box.className = 'company-profile company-quote cq-wide';
      box.setAttribute('aria-labelledby', 'cq-title');
    }
    // يبقى تحت النبذة حتى لو أُعيد رسمها
    if (box.previousElementSibling !== anchor) anchor.after(box);
    shown = symbol;
    box.innerHTML = card(stock);
    startLive(symbol, stock, box);
    const sessionPromise = loadSession(symbol);
    const [ohlc, intraday] = await Promise.all([loadCandles(symbol), loadIntraday(symbol)]), slot = box.querySelector('.cq-mini-slot');
    let session = null;
    if (shown !== symbol || !slot) return;
    const render = () => {
      const data = miniSeries(ohlc, miniRange, intraday, session);
      slot.innerHTML = data ? miniHtml(symbol, miniRange, data) : MINI_EMPTY;
      if (data) bindMini(slot, data);
    };
    render();
    // جلسة اليوم تصل لاحقًا (لا ننتظرها): يُعاد الرسم إن كانت المدة المختارة يومًا أو خمسة أيام
    sessionPromise.then(value => {
      session = value;
      if (value && shown === symbol && slot.isConnected && MINI_RANGES.find(r => r.id === miniRange)?.sessions) render();
    });
    // تغيير المدة يعيد رسم الشارت الصغير فقط
    slot.addEventListener('click', event => {
      const b = event.target.closest('[data-mini-range]');
      if (!b) return;
      event.preventDefault();
      miniRange = b.dataset.miniRange;
      render();
    });
  }

  async function start() {
    try {
      const prices = await fetch('data.json').then(r => r.json());
      stocks = new Map(prices.sectors.flatMap(sector => sector.stocks).map(stock => [String(stock.symbol), stock]));
      // آخر سعر لحظي محفوظ (إن كان أحدث من لقطة data.json) فلا يظهر سعر أمس أولًا
      const lq = window.LiveQuotes;
      if (lq?.enabled) for (const [symbol, q] of lq.loadCache(Date.parse(prices.priceSource?.checkedAt) || 0)) {
        const stock = stocks.get(symbol);
        if (!stock) continue;
        stock.price = q.price;
        if (Number.isFinite(q.pct)) stock.day = q.pct;
        stock.priceStatus = q.status === 'Closed' ? 'close' : 'realtime';
        stock.priceDate = lq.dateOf(q) || stock.priceDate;
      }
    } catch (error) { console.warn('Price snapshot unavailable:', error); return; }
    paint();
    new MutationObserver(() => { paint(); const box = document.getElementById('company-quote'), anchor = document.getElementById('company-profile'); if (box && anchor && box.previousElementSibling !== anchor) anchor.after(box); }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
