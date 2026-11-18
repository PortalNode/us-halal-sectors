// صفحة «التحليل الفني»: شارت السهم (company-chart.js). السهم من ?symbol= في الرابط؛ وإن لم يوجد يُعرض أكبر سهم قيمة سوقية.
// SPUS (الصندوق المتتبع لمؤشر S&P 500 الشرعي) يعمل كمؤشر مرجعي كما كان تاسي في الموقع الأصلي.
(() => {
  const INDEX = { symbol: 'SPUS', name: 'صندوق SPUS (مؤشر S&P 500 الشرعي)' };
  const status = document.getElementById('ta-status');
  const panel = document.getElementById('ta-chart');
  const params = new URLSearchParams(location.search);
  const fail = message => { if (status) status.textContent = message; };

  const fetchData = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { const r = await fetch('data.json'); if (r.ok) return await r.json(); } catch { /* retry */ }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    }
    throw new Error('data.json unavailable');
  };

  async function mountChart(requested) {
    let data;
    try { data = await fetchData(); } catch { fail('تعذر تحميل قائمة الأسهم.'); return; }
    const stocks = new Map(data.sectors.flatMap(sector => sector.stocks).map(stock => [String(stock.symbol), stock]));
    const biggest = [...stocks.values()].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))[0]?.symbol;
    const isIndex = String(requested).toUpperCase() === INDEX.symbol;
    const symbol = isIndex ? INDEX.symbol : requested && stocks.has(String(requested).toUpperCase()) ? String(requested).toUpperCase() : biggest;
    const stock = isIndex ? INDEX : stocks.get(symbol);
    document.title = `${stock.name} · التحليل الفني | السوق الأمريكي الشرعي`;
    if (!window.CompanyChart) { fail('تعذر تحميل مكتبة الشارت.'); return; }
    const file = await window.CompanyChart.load(symbol);
    if (!file) { fail(`تعذر تحميل شموع ${symbol}. جرّب إعادة تحميل الصفحة بعد قليل.`); return; }
    document.getElementById('ta-status')?.remove();
    window.CompanyChart.mount(panel, file, { home: { symbol, file, name: stock.name } });
  }
  const start = () => mountChart(params.get('symbol'));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
