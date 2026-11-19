// صفحة «التحليل الفني»: «مفاتيح جودة السهم» وقائمة المراقبة وشارت السهم (company-chart.js) في صفحة واحدة.
// السهم من ?symbol= في الرابط (أو SPUS لمؤشر السوق المرجعي)؛ وإن لم يوجد أو لم يكن في القائمة يُعرض أكبر سهم قيمة سوقية.
// الصفحة تُفتح على الشارت، وعلى الماسح أو المراقبة إن جاء الرابط بـ #scanner أو #watch (دون ?symbol=).
// اختيار سهم آخر يتم من زر البحث داخل الشارت نفسه.
(() => {
  const INDEX = { symbol: 'SPUS', name: 'صندوق SPUS (مؤشر S&P 500 الشرعي)' }; // شموعه في ohlc/SPUS.json
  const SCANNER_MODULE = './scanner/scanner-ui.mjs?v=sc-us-20261119';
  const TABS = ['chart', 'scanner', 'watch'];
  const status = document.getElementById('ta-status');
  const panel = document.getElementById('ta-chart');
  const params = new URLSearchParams(location.search);
  let stocks = null, mounted = null;

  const fail = message => { if (status) status.textContent = message; };

  // data.json قد يعطي خطأ خادم مؤقتاً لحظة نشر الموقع: تُعاد المحاولة مرتين قبل إظهار الفشل
  const fetchData = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { const r = await fetch('data.json'); if (r.ok) return await r.json(); } catch { /* retry */ }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    }
    throw new Error('data.json unavailable');
  };
  const ready = fetchData().then(data => {
    stocks = new Map(data.sectors.flatMap(sector => sector.stocks).map(stock => [String(stock.symbol), stock]));
    return stocks;
  }).catch(error => {
    console.warn('Price snapshot unavailable:', error);
    fail('تعذر تحميل قائمة الأسهم.');
    return null;
  });

  // يعرض شارت السهم؛ levels: مناطق/خطوط سعر مرجعية (دعم/مقاومة) يرسمها الشارت دون حفظها
  async function mountChart(requested, levels = []) {
    const map = stocks || await ready;
    if (!map) return false;
    const want = requested ? String(requested).toUpperCase() : '';
    const isIndex = want === INDEX.symbol;
    const biggest = [...map.values()].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))[0]?.symbol;
    const symbol = isIndex ? INDEX.symbol : want && map.has(want) ? want : biggest;
    const stock = isIndex ? INDEX : map.get(symbol);
    if (!stock) { fail('لا يوجد سهم بهذا الرمز.'); return false; }
    document.title = `${stock.name} · التحليل الفني | السوق الأمريكي الشرعي`;
    if (!window.CompanyChart) { fail('تعذر تحميل مكتبة الشارت.'); return false; }
    const file = await window.CompanyChart.load(symbol);
    if (!file) { fail(`تعذر تحميل شموع ${symbol}. جرّب إعادة تحميل الصفحة بعد قليل.`); return false; }
    document.getElementById('ta-status')?.remove();
    window.CompanyChart.mount(panel, file, { home: { symbol, file, name: stock.name }, levels });
    mounted = symbol;
    return true;
  }

  function setTab(name, { remember = true, mount = true } = {}) {
    if (!TABS.includes(name)) name = 'chart';
    document.body.dataset.tab = name;
    for (const b of document.querySelectorAll('[data-tab-button]')) b.setAttribute('aria-selected', String(b.dataset.tabButton === name));
    if (remember) { try { history.replaceState(null, '', `${location.pathname}${location.search}#${name}`); } catch { /* ignore */ } }
    if (name === 'chart' && mount && !mounted) mountChart(params.get('symbol'));
  }

  const api = { ready, mountChart, setTab, current: () => mounted, chartPanel: panel };
  window.TA = api;

  function start() {
    for (const b of document.querySelectorAll('[data-tab-button]')) b.addEventListener('click', () => setTab(b.dataset.tabButton));
    const hash = location.hash.slice(1);
    const initial = TABS.includes(hash) && !params.has('symbol') ? hash : 'chart';
    setTab(initial, { remember: false });
    // الماسح وحدة منفصلة: إن تعذر تحميلها يبقى الشارت يعمل كما كان
    import(SCANNER_MODULE).then(m => m.init(api, initial)).catch(error => {
      console.warn('Scanner unavailable:', error);
      const box = document.getElementById('sc-scanner');
      if (box) box.innerHTML = '<p class="cq-empty">تعذر تحميل الماسح. الشارت يعمل من تبويب «الشارت».</p>';
      if (initial !== 'chart') setTab('chart', { remember: false });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
