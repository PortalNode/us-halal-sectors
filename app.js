// السوق الأمريكي الشرعي — الصفحة الرئيسية.
// البيانات من data.json (يولّده scripts/build_data.py) مع تحديث حي من TradingView داخل المتصفح.
const columns = [
  ['symbol','رمز السهم','symbol'],['name','اسم الشركة','name'],['price','سعر السهم ($)','price'],['day','تغير اليوم','day'],
  ['eps','ربحية السهم','eps'],['pe','مكرر الأرباح','pe'],['bookValue','القيمة الدفترية','bv'],
  ['pb','مكرر القيمة الدفترية','pb'],['dividendYield','عائد التوزيع','yield'],['week52Position','آخر 52 أسبوع','week52'],['marketCap','القيمة السوقية (مليار $)','mcap'],['tradedValue','القيمة المتداولة (مليون $)','tval'],['ytd','الأداء منذ بداية السنة','ytd'],['month3','تغير 3 أشهر','3m'],
  ['month6','تغير 6 أشهر','6m'],['year1','تغير سنة','1y']
];
const TZ = 'America/New_York';
const INDEX_TV = 'SP:SPX';
const numberFormat = new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const integerFormat = new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
const epsFormat = new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const timeFormat = new Intl.DateTimeFormat('ar-SA',{timeZone:TZ,hour:'2-digit',minute:'2-digit'});
let data, activeSector = null, query = '', sortBySector = new Map([['all',{key:'marketCap',dir:-1}]]), epsMode = 'recurring', pricesRefreshRunning = false, priceRefreshError = '';

// المجموعات الرئيسية لمنتقي القطاعات (بمفاتيح قطاعات TradingView). ما لم يُذكر يدخل «أخرى».
const SECTOR_GROUPS = [
  ['التقنية والاتصالات',['Electronic Technology','Technology Services','Communications']],
  ['الصحة',['Health Technology','Health Services']],
  ['الطاقة والمواد',['Energy Minerals','Non-Energy Minerals','Process Industries','Utilities']],
  ['الصناعة والخدمات',['Producer Manufacturing','Industrial Services','Commercial Services','Distribution Services','Transportation']],
  ['الاستهلاك',['Consumer Durables','Consumer Non-Durables','Consumer Services','Retail Trade']],
  ['المالية والعقار',['Finance','REIT','Miscellaneous']]
];
let sectorGroup = null;
// المفضلة: رموز تُحفظ في هذا المتصفح فقط.
const FAVORITES_KEY = 'us-halal-favorites';
function loadFavorites(){
  try{const list=JSON.parse(localStorage.getItem(FAVORITES_KEY)||'[]');return new Set(Array.isArray(list)?list.map(String):[]);}
  catch{return new Set();}
}
let favorites = loadFavorites(), favoritesView = false;
function saveFavorites(){try{localStorage.setItem(FAVORITES_KEY,JSON.stringify([...favorites]));}catch{/* storage unavailable */}}
function favoriteButton(stock){
  const on=favorites.has(stock.symbol);
  return `<button type="button" class="fav-toggle${on?' on':''}" data-fav="${escapeHtml(stock.symbol)}" aria-pressed="${on}" aria-label="${on?'إزالة':'إضافة'} ${escapeHtml(stock.name)} ${on?'من':'إلى'} المفضلة" title="${on?'إزالة من المفضلة':'إضافة إلى المفضلة · تُحفظ في هذا المتصفح'}">${on?'★':'☆'}</button>`;
}
function toggleFavorite(symbol){
  if(favorites.has(symbol))favorites.delete(symbol);else favorites.add(symbol);
  saveFavorites();
  if(favoritesView){
    const wrap=document.querySelector('#sector-fav .table-wrap'),scroll=wrap?.scrollLeft;
    render();
    const next=document.querySelector('#sector-fav .table-wrap');if(next&&scroll!=null)next.scrollLeft=scroll;
    return;
  }
  // في غير المفضلة نحدّث النجوم في مكانها ليحتفظ الجدول بموضع التمرير.
  const stock=allStocks().find(s=>s.symbol===symbol);
  for(const button of document.querySelectorAll('[data-fav]'))if(button.dataset.fav===symbol&&stock)button.outerHTML=favoriteButton(stock);
  nav();
}
globalThis.addEventListener?.('storage',event=>{if(event.key===FAVORITES_KEY){favorites=loadFavorites();if(data)render();}});
function sectorGroups(){
  const known=new Set(SECTOR_GROUPS.flatMap(group=>group[1]));
  const groups=SECTOR_GROUPS.map(([label,keys])=>({label,indexes:keys.map(key=>data.sectors.findIndex(sector=>sector.key===key)).filter(index=>index>=0)})).filter(group=>group.indexes.length);
  const rest=data.sectors.map((sector,index)=>known.has(sector.key)?-1:index).filter(index=>index>=0);
  if(rest.length)groups.push({label:'أخرى',indexes:rest});
  return groups;
}
function groupOfSector(index){return sectorGroups().findIndex(group=>group.indexes.includes(index));}
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normalized = value => String(value ?? '').normalize('NFKD').replace(/[ً-ٰٟ]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').toLowerCase().trim();
const numeric = (n, digits=2) => n == null ? '<span class="missing">—</span>' : `<span class="num">${digits===3?epsFormat.format(n):numberFormat.format(n)}</span>`;
const percent = (n, signed=true) => n == null ? '<span class="missing">—</span>' : `<span class="num ${signed?(n>0?'up':n<0?'down':'flat'):'dividend-yield'}">${signed&&n>0?'+':''}${numberFormat.format(n)}%</span>`;
const pe = stock => stock.pe != null ? numeric(stock.pe) : stock.eps != null && stock.eps < 0 ? '<span class="loss">خاسرة</span>' : '<span class="missing">—</span>';
const allStocks = () => data.sectors.flatMap(s => s.stocks);
const safeNumber = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

// النطاق يُعرض الأعلى يسارًا والأدنى يمينًا؛ الترتيب بحسب موضع السعر الحالي من الأدنى للأعلى.
function range52Position(stock){
  const low=safeNumber(stock.week52Low),high=safeNumber(stock.week52High),price=safeNumber(stock.price);
  if(low==null||high==null||price==null||low<=0||high<low||price<=0)return null;
  if(high===low)return price===low?0.5:price>high?1:0;
  return Math.max(0,Math.min(1,(price-low)/(high-low)));
}
function range52(stock){
  const low=safeNumber(stock.week52Low),high=safeNumber(stock.week52High);
  if(low==null||high==null||low<=0||high<low)return '<span class="missing" title="نطاق آخر 52 أسبوعًا غير متاح">—</span>';
  const price=safeNumber(stock.price),position=range52Position(stock);
  const checked=stock.week52CheckedAt?new Date(stock.week52CheckedAt):null;
  const checkedLabel=checked&&!Number.isNaN(checked.getTime())?new Intl.DateTimeFormat('ar-SA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(checked):null;
  const title=`أعلى سعر: ${numberFormat.format(high)}، أدنى سعر: ${numberFormat.format(low)}${position==null?'؛ السعر الحالي غير متاح':`، السعر الحالي: ${numberFormat.format(price)}`}${stock.week52Source?`؛ المصدر: ${providerLabel(stock.week52Source)}`:''}${checkedLabel?`؛ فُحص ${checkedLabel} بتوقيت نيويورك`:''}`;
  const marker=position==null?'':`<span class="range52-marker" style="left:${((1-position)*100).toFixed(2)}%"></span>`;
  return `<div class="range52" role="img" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}"><div class="range52-track">${marker}</div><div class="range52-labels" aria-hidden="true"><span>${numberFormat.format(high)}</span><span>${numberFormat.format(low)}</span></div></div>`;
}

const sourceLabel = {
  'Nasdaq':'ناسداك (آخر صفقة لحظية)',
  'TradingView':'تريدينغ فيو','SP Funds':'إس بي فندز','Yahoo Finance':'Yahoo Finance'
};
const displayDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value||'') ? value.split('-').reverse().join('.') : /^\d{2}\.\d{2}\.\d{4}$/.test(value||'') ? value : null;
const providerLabel = value => sourceLabel[value] || value || 'مصدر غير محدد';
const snapshotLabel = () => displayDate(data.priceSource?.mode==='close' ? data.priceSource.officialDate || data.priceDate : data.priceSource?.observedDate || data.priceDate) || '—';
const timestamp = value => value ? new Date(value).getTime() : NaN;
const checkedLabel = value => {const date=new Date(value);return !value||Number.isNaN(date.getTime())?null:`${new Intl.DateTimeFormat('en-GB',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(date)} ${timeFormat.format(date)} بتوقيت نيويورك`};
// ساعات التداول المعتادة في بورصتي نيويورك وناسداك (9:30–16:00 ET) مع هامش للمزاد الختامي.
// هذا تنبيه لحداثة البيانات وليس ادعاءً بأن الجلسة مفتوحة الآن.
function etParts(now){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:TZ,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  return type=>parts.find(p=>p.type===type)?.value;
}
function isMarketHours(now=new Date()){
  const part=etParts(now);
  const minutes=Number(part('hour'))*60+Number(part('minute'));
  return !['Sat','Sun'].includes(part('weekday')) && minutes>=9*60+30 && minutes<16*60+5;
}
function paintPriceStatus(){
  const source=data?.priceSource||{},messages=[];
  if(source.warning)messages.push(source.warning);
  if(source.unavailableSymbols>0)messages.push(`السعر غير متاح لـ ${source.unavailableSymbols} سهمًا.`);
  const checked=checkedLabel(source.checkedAt);
  messages.push(checked?`آخر فحص لنسخة الأسعار: ${checked}.`:'وقت آخر فحص لنسخة الأسعار غير متاح.');
  if(isMarketHours() && Number.isFinite(timestamp(source.checkedAt)) && Date.now()-timestamp(source.checkedAt)>35*60*1000)messages.push('نسخة الأسعار قديمة: مضى أكثر من 35 دقيقة على آخر فحص خلال ساعات التداول المعتادة.');
  if(globalThis.LiveQuotes?.enabled){
    const st=LiveQuotes.status;
    if(st.ok===false)messages.push(`تعذر الاتصال بوسيط الأسعار اللحظية (${st.error})؛ تُعرض أسعار متأخرة.`);
    else if(data?.priceSource?.mode==='realtime')messages.push(`أسعار لحظية من Nasdaq (Last Sale: صفقات ناسداك الحية، قد تختلف قليلًا عن السعر المجمّع)؛ آخر تحديث ${new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(st.at||Date.now()))} بتوقيت نيويورك.`);
  }
  if(priceRefreshError)messages.push(priceRefreshError);
  const node=$('price-status');if(node)node.textContent=messages.join(' ');
}
function paintSnapshot(){
  const date=snapshotLabel();
  for(const id of ['price-date','price-date-note','price-date-footer']){
    const node=$(id);
    if(node) node.textContent=date;
  }
  const mode=$('price-mode');
  const closed=data.priceSource?.mode==='close', realtime=data.priceSource?.mode==='realtime';
  const delay=safeNumber(data.priceSource?.delayMinutes);
  if(mode)mode.textContent=realtime?`أسعار لحظية${statusSuffix()}`:closed?(date==='—'?'إغلاق الجلسة · آخر إغلاق متاح':'إغلاق الجلسة'):`أسعار متأخرة · غير مؤكدة رسميًا${delay!=null&&delay>0?` · تأخير المصدر ${delay} دقيقة`:''}`;
  const source=$('price-source');
  if(source)source.textContent=providerLabel(data.priceSource?.provider);
  paintPriceStatus();
}
function paintShariahNote(){
  const info=data?.shariah,node=$('shariah-note');
  if(!node)return;
  if(!info){node.textContent='';return;}
  const date=displayDate(info.holdingsDate);
  node.textContent=`قائمة الشركات الشرعية مأخوذة من حيازات صندوق ${info.source} (${info.sourceName}) المتتبع لمؤشر ${info.indexName}${date?` بتاريخ ${date}`:''}؛ ${info.listedCount} شركة معروضة من ${info.holdingsCount} حيازة. تُطبَّق على المؤشر ضوابط استبعاد الأنشطة المحرمة ونسب الديون والنقد والفوائد وفق معايير مقدّم المؤشر، ويُعاد فحصها دوريًا فقد تخرج شركة أو تدخل. هذه المعلومات للاطلاع وليست فتوى؛ تحقق من توافق السهم مع مرجعك الشرعي قبل الاستثمار، وتذكّر تطهير أي أرباح موزعة وفق ضوابط جهتك.`;
}
const MARKET_STATUS={Open:'الجلسة مفتوحة','Pre-Market':'ما قبل الافتتاح','After-Hours':'ما بعد الإغلاق',Closed:'مغلق'};
const statusSuffix=()=>data?.marketStatus?` · ${MARKET_STATUS[data.marketStatus]||data.marketStatus}`:'';
function stockPriceLabel(stock){
  const date=displayDate(stock.priceDate);
  const status=stock.priceStatus==='realtime'?'سعر لحظي (Nasdaq Last Sale)':stock.priceStatus==='close'||stock.priceStatus==='official_close'?'إغلاق الجلسة':stock.priceStatus==='unavailable'||stock.price==null?'السعر غير متاح':'سعر متأخر · غير مؤكد رسميًا';
  return `${status} · ${date||'تاريخ السعر غير متاح'} · المصدر: ${providerLabel(stock.priceSource || data.priceSource?.provider)}`;
}
function applyFinancials(){
  for(const stock of allStocks()){
    const diluted=safeNumber(stock.epsDiluted ?? stock.eps),basic=safeNumber(stock.epsBasic);
    const preferred=epsMode==='recurring'?diluted:basic, fallback=epsMode==='recurring'?basic:diluted;
    const chosen=preferred ?? fallback;
    const kind=preferred!=null?(epsMode==='recurring'?'مخففة':'أساسية'):fallback!=null?(epsMode==='recurring'?'أساسية':'مخففة'):null;
    stock.eps=chosen;
    const price=safeNumber(stock.price);
    stock.pe=stock.eps > 0 && price != null && price > 0 ? price/stock.eps : null;
    const book=safeNumber(stock.bookValue);
    stock.pb=book > 0 && price != null && price > 0 ? price/book : null;
    const period=data.financialPeriod?` · ${data.financialPeriod}`:'';
    stock._epsSource=chosen==null?'ربحية السهم غير متاحة':`تريدينغ فيو · ربحية ${kind} لآخر 12 شهرًا${period}`;
    stock._bookSource=`تريدينغ فيو · القيمة الدفترية للسهم في آخر ربع معلن`;
    stock._hasCurrentEps=chosen!=null;
  }
  render();
}
function marketDailyChange(summary){
  const day=safeNumber(summary.day),points=safeNumber(summary.pointChange);
  if(day==null)return '—';
  const direction=day>0?'ارتفاع':day<0?'انخفاض':'دون تغيير';
  const arrow=day>0?'▲':day<0?'▼':'';
  const amount=points==null?'—':numberFormat.format(Math.abs(points));
  const rate=numberFormat.format(Math.abs(day));
  const label=`${direction}؛ ${points==null?'التغيير بالدولار غير متاح':`${amount} دولار`}؛ ${rate} بالمئة`;
  return `<span class="market-daily-change" role="img" aria-label="${escapeHtml(label)}"><span class="market-direction" aria-hidden="true">${arrow}</span><bdi class="market-points" aria-hidden="true">${amount}</bdi><span class="market-percent" aria-hidden="true"><bdi>${rate}</bdi> %</span></span>`;
}
function paintMarketSummary(){
  const m=data.marketSummary||{};
  const breadth=allStocks().reduce((counts,stock)=>{const change=safeNumber(stock.day);if(change>0)counts.up++;else if(change<0)counts.down++;else if(change===0)counts.flat++;return counts;},{up:0,down:0,flat:0});
  const mode=m.mode || (m.isIntraday?'delayed':null);
  const source=providerLabel(m.source);
  const date=displayDate(m.date);
  const daily=marketDailyChange(m);
  const items=[
    {label:'قيمة المؤشر',value:m.value==null?'—':numberFormat.format(m.value)},
    {label:'التغيير اليومي',value:daily,trend:m.day},
    {label:'الشركات المرتفعة',value:integerFormat.format(breadth.up),trend:1},
    {label:'الشركات المنخفضة',value:integerFormat.format(breadth.down),trend:-1},
    {label:'دون تغيير',value:integerFormat.format(breadth.flat),trend:0},
    {label:'القيمة المتداولة',value:m.turnover==null?'—':integerFormat.format(m.turnover),source:m.turnoverSource,estimated:m.turnoverEstimated===true},
    {label:'منذ بداية السنة',value:m.ytd,percent:true},
    {label:'3 أشهر',value:m.month3,percent:true},
    {label:'6 أشهر',value:m.month6,percent:true},
    {label:'سنة',value:m.year1,percent:true}
  ];
  const cards=items.map(item=>{
    const trend=item.trend ?? (item.percent?item.value:null);
    const display=item.percent?(item.value==null?'—':`${item.value>0?'+':''}${numberFormat.format(item.value)}%`):item.value;
    const cls=typeof trend==='number'?(trend>0?'up':trend<0?'down':'flat'):'';
    const estimatedMark=item.estimated&&item.value!=='—'?' <small>(تقديري)</small>':'';
    const itemSource=item.percent?providerLabel(m.performanceSource):item.source?providerLabel(item.source):source;
    const title=item.label.startsWith('الشركات')||item.label==='دون تغيير'?`محسوب من بيانات أسهم الجدول · ${providerLabel(data.priceSource?.provider)} · ${snapshotLabel()}`:`المصدر: ${itemSource} · ${item.percent?'تاريخ بيانات الأداء':'تاريخ المؤشر'}: ${item.percent?m.performanceDate||'غير متاح':date||'غير متاح'}${item.estimated?' · تقدير من أحجام الأسهم المتأخرة ويُستبدل بالقيمة النهائية عند الإغلاق':''}${item.label==='القيمة المتداولة'?' · مجموع قيمة تداول الشركات المعروضة':''}`;
    return `<div class="market-card" title="${escapeHtml(title)}"><span>${item.label}</span><strong class="${cls}">${display}${estimatedMark}</strong></div>`;
  });
  const indexLogo='<img class="co-logo co-logo-md market-group-logo" src="logos/SPX.svg" alt="" width="32" height="32" decoding="async" onerror="this.remove()">';
  const group=(label,body,kind)=>`<div class="market-group market-group-${kind}">${kind==='index'?indexLogo:''}<span class="market-group-label">${label}</span><div class="market-group-cards">${body}</div></div>`;
  const breadthBar=`<div class="breadth-bar" aria-hidden="true"><i class="breadth-up" style="flex:${breadth.up}"></i><i class="breadth-flat" style="flex:${breadth.flat}"></i><i class="breadth-down" style="flex:${breadth.down}"></i></div>`;
  $('market-stats').innerHTML=group('المؤشر المرجعي · S&P 500',cards[0]+cards[1],'index')+group('اتساع السوق',breadthBar+cards[2]+cards[4]+cards[3],'breadth')+group('القيمة المتداولة (دولار)',cards[5],'turnover')+group('أداء المؤشر',cards.slice(6).join(''),'performance');
  const checked=checkedLabel(m.updatedAt);
  const label=mode==='realtime'?'أسعار لحظية':mode==='close'?'إغلاق الجلسة':mode==='delayed'?'بيانات متأخرة · غير مؤكدة رسميًا':'بيانات المؤشر';
  $('market-date').textContent=m.date||m.value!=null?`${label} · ${date||(mode==='close'?'آخر إغلاق متاح':'تاريخ غير متاح')} · ${source}${checked?` · آخر فحص ${checked}`:''} · المرجع: مؤشر S&P 500`:'بانتظار تحديث المؤشر';
}
function sectorChange(stocks){
  let weighted=0,total=0;
  for(const stock of stocks){const change=safeNumber(stock.day),cap=safeNumber(stock.marketCap);if(change==null||cap==null||cap<=0)continue;weighted+=change*cap;total+=cap;}
  return total?weighted/total:null;
}
function nav(){
  const groups=sectorGroups();
  if(activeSector!==null)sectorGroup=groupOfSector(activeSector);
  if(sectorGroup!==null&&!groups[sectorGroup])sectorGroup=null;
  const allActive=!favoritesView&&activeSector===null&&sectorGroup===null;
  const favoriteCount=allStocks().filter(s=>favorites.has(s.symbol)).length;
  const groupButtons=`<button class="group-button favorites-button ${favoritesView?'active':''}" data-favorites type="button" aria-pressed="${favoritesView}" title="الأسهم التي أضفتها إلى المفضلة · تُحفظ في هذا المتصفح"><span class="fav-icon" aria-hidden="true">★</span><span>المفضلة</span><span class="count">${favoriteCount}</span></button>`+
    `<button class="group-button ${allActive?'active':''}" data-sector="all" type="button" aria-pressed="${allActive}" title="جميع القطاعات · ${allStocks().length} شركة"><span>جميع القطاعات</span><span class="count">${allStocks().length}</span></button>`+
    groups.map((group,gi)=>`<button class="group-button ${sectorGroup===gi?'active':''}" data-group="${gi}" type="button" aria-pressed="${sectorGroup===gi}"><span>${escapeHtml(group.label)}</span><span class="count">${group.indexes.reduce((total,index)=>total+data.sectors[index].stocks.length,0)}</span></button>`).join('');
  const chips=sectorGroup===null?'':groups[sectorGroup].indexes.map(i=>{
    const sector=data.sectors[i],change=sectorChange(sector.stocks),changeClass=change==null?'flat':change>0?'up':change<0?'down':'flat',changeText=change==null?'—':`${change>0?'+':''}${numberFormat.format(change)}%`;
    return `<button class="sector-button ${activeSector===i?'active':''}" data-sector="${i}" type="button" aria-pressed="${activeSector===i}" title="${escapeHtml(sector.name)} · ${sector.stocks.length} شركة · تغير مرجح محسوب"><span>${escapeHtml(sector.name)}</span><span class="count">${sector.stocks.length}</span><span class="sector-chip-change ${changeClass}">${changeText}</span></button>`;
  }).join('');
  $('sector-nav').innerHTML=`<div class="sector-groups" role="group" aria-label="مجموعات القطاعات">${groupButtons}</div>${chips?`<div class="sector-chips" role="group" aria-label="قطاعات ${escapeHtml(groups[sectorGroup].label)}">${chips}</div>`:''}`;
}
function row(stock){
  const dividendTitle=stock.dividendYield==null?'عائد التوزيع غير متاح':`عائد التوزيع لآخر 12 شهرًا · المصدر: ${providerLabel(stock.priceSource)}`;
  const priceTitle=stockPriceLabel(stock);
  const performanceTitle=`تاريخ بيانات الأداء: ${stock.performanceDate||'غير متاح'}`;
  const companyTitle=`${stock.nameEn||stock.name}${stock.industry?` · ${stock.industry}`:''} · ${stock.exchange||''} · النتائج السنوية`;
  const companyLabel=`<a class="company-results-link" href="company.html?symbol=${encodeURIComponent(stock.symbol)}" title="${escapeHtml(companyTitle)}">${escapeHtml(stock.name)}</a>`;
  return `<tr><td class="sticky-1"><span class="symbol-cell">${favoriteButton(stock)}<span class="symbol-badge">${escapeHtml(stock.symbol)}</span></span></td><td class="sticky-2 company-name">${companyLabel}</td><td title="${escapeHtml(priceTitle)}">${stock.price==null?'<span class="missing">—</span>':`<span class="num price">${numberFormat.format(stock.price)}</span>`}</td><td>${percent(stock.day)}</td><td title="${escapeHtml(stock._epsSource||'')}">${numeric(stock.eps,2)}</td><td>${pe(stock)}</td><td title="${escapeHtml(stock._bookSource||'')}">${numeric(stock.bookValue)}</td><td>${numeric(stock.pb)}</td><td title="${escapeHtml(dividendTitle)}">${percent(stock.dividendYield,false)}</td><td>${range52(stock)}</td><td title="${escapeHtml(`القيمة السوقية بمليار دولار · ${priceTitle}`)}">${numeric(stock.marketCap)}</td><td title="${escapeHtml(`القيمة المتداولة بمليون دولار · ${priceTitle}`)}">${stock.tradedValue==null?'<span class="missing">—</span>':`<span class="num">${numberFormat.format(stock.tradedValue/1e6)}</span>`}</td><td title="${escapeHtml(performanceTitle)}">${percent(stock.ytd)}</td><td title="${escapeHtml(performanceTitle)}">${percent(stock.month3)}</td><td title="${escapeHtml(performanceTitle)}">${percent(stock.month6)}</td><td title="${escapeHtml(performanceTitle)}">${percent(stock.year1)}</td></tr>`;
}
function matches(stock){
  if(!query)return true;
  return normalized(stock.name).includes(query)||normalized(stock.nameEn).includes(query)||stock.symbol.toLowerCase().includes(query);
}
function render(){
  nav();
  const favoriteStocks=favoritesView?allStocks().filter(s=>favorites.has(s.symbol)):[];
  const selected=favoritesView
    ? [{index:'fav',name:'المفضلة',stocks:favoriteStocks}]
    : activeSector===null
    ? [{index:'all',name:sectorGroup===null?'جميع الشركات':sectorGroups()[sectorGroup]?.label||'جميع الشركات',stocks:sectorGroup===null?allStocks():(sectorGroups()[sectorGroup]?.indexes||[]).flatMap(i=>data.sectors[i].stocks)}]
    : [{index:activeSector,name:data.sectors[activeSector].name,stocks:data.sectors[activeSector].stocks}];
  const filtered=selected.map(group=>({...group,stocks:group.stocks.filter(matches)})).filter(group=>group.stocks.length);
  const count=filtered.reduce((n,group)=>n+group.stocks.length,0);
  $('view-title').textContent=favoritesView?'المفضلة':activeSector===null?(sectorGroup===null?'جميع القطاعات':sectorGroups()[sectorGroup]?.label||'جميع القطاعات'):data.sectors[activeSector].name;
  const allSort=sortBySector.get('all');
  $('result-count').textContent=favoritesView?`${count} ${count===1?'سهم':'أسهم'} في المفضلة · تُحفظ في هذا المتصفح`:activeSector===null&&sectorGroup!==null?`${count} شركة في مجموعة ${sectorGroups()[sectorGroup]?.label||''}`:activeSector===null?`${count} شركة في جدول واحد${allSort?.key==='marketCap'&&allSort.dir===-1?' · الأكبر قيمة سوقية أولًا':''}`:`${count} شركة في قطاع ${data.sectors[activeSector].name}`;
  $('clear').hidden=!query;
  $('empty').hidden=filtered.length!==0;
  const noFavorites=favoritesView&&!favoriteStocks.length;
  $('empty').querySelector('.empty-icon').textContent=noFavorites?'☆':'⌕';
  $('empty').querySelector('h3').textContent=noFavorites?'لم تضف أي سهم إلى المفضلة بعد':'لا توجد نتائج مطابقة';
  $('empty').querySelector('p').textContent=noFavorites?'اضغط النجمة ☆ بجانب رمز أي سهم في الجدول لإضافته هنا.':'جرّب البحث باسم آخر أو برمز السهم.';
  $('sectors').innerHTML=filtered.map(({name,index,stocks})=>{
    const sort=sortBySector.get(index);
    if(sort){stocks=[...stocks].sort((a,b)=>{
      const av=sort.key==='week52Position'?range52Position(a):a[sort.key],bv=sort.key==='week52Position'?range52Position(b):b[sort.key];
      if(av==null) return 1;if(bv==null)return -1;
      return (typeof av==='string'?av.localeCompare(bv,sort.key==='symbol'?'en':'ar'):av-bv)*sort.dir || a.symbol.localeCompare(b.symbol,'en');
    });}
    const change=sectorChange(index==='all'?allStocks():index==='fav'?stocks:data.sectors[index].stocks),changeClass=change==null?'':change>0?'up':change<0?'down':'flat',changeText=change==null?'—':`${change>0?'+':''}${numberFormat.format(change)}%`;
    const sectorKey=typeof index==='number'?data.sectors[index].key:null;
    const annualResultsLink=sectorKey?`<a class="bank-results-link" href="company.html?sector=${encodeURIComponent(sectorKey)}">النتائج السنوية</a>`:'';
    return `<section class="sector-section" id="sector-${index}" aria-labelledby="heading-${index}"><div class="sector-heading"><div class="sector-title-wrap">${index==='all'||index==='fav'?'':`<span class="sector-index">${String(index+1).padStart(2,'0')}</span>`}<h3 id="heading-${index}">${escapeHtml(name)}</h3></div><div class="sector-meta">${annualResultsLink}<span class="sector-pill">${stocks.length} ${index==='all'||stocks.length===1?'شركة':'شركات'}</span>${index==='all'||index==='fav'?'':`<span class="sector-performance ${changeClass}" title="تغير محسوب مرجح بالقيمة السوقية لجميع شركات القطاع؛ ليس مؤشر قطاع رسميًا">تغير مرجح محسوب <strong>${changeText}</strong></span>`}</div></div><div class="table-wrap" tabindex="0" aria-label="جدول ${escapeHtml(name)}؛ مرر أفقيًا لرؤية كل الأعمدة"><table><colgroup>${columns.map(c=>`<col class="col-${c[2]}">`).join('')}</colgroup><thead><tr>${columns.map(([key,label],ci)=>`<th class="${ci===0?'sticky-1':ci===1?'sticky-2':''}" scope="col"><button type="button" data-sort="${key}" data-index="${index}" class="${sort?.key===key?'sorted':''}" aria-label="ترتيب حسب ${label}">${label}<span class="sort-glyph">${sort?.key===key?(sort.dir===1?'↑':'↓'):'↕'}</span></button></th>`).join('')}</tr></thead><tbody>${stocks.map(row).join('')}</tbody></table></div></section>`;
  }).join('');
}
function updateStatus(message){$('financial-status').textContent=message;}
function updateMode(mode){
  epsMode=mode;
  $('recurring-mode').classList.toggle('selected',mode==='recurring');
  $('reported-mode').classList.toggle('selected',mode==='reported');
  $('recurring-mode').setAttribute('aria-pressed',String(mode==='recurring'));
  $('reported-mode').setAttribute('aria-pressed',String(mode==='reported'));
  applyFinancials();
  const updated=allStocks().filter(s=>s._hasCurrentEps).length;
  updateStatus(`ربحية ${updated} سهمًا (${mode==='recurring'?'مخففة':'أساسية'}، آخر 12 شهرًا)؛ ${allStocks().length-updated} سهمًا بلا ربحية متاحة. عائد التوزيع لآخر 12 شهرًا من تريدينغ فيو.`);
}

/*
 * تحديث مباشر أثناء جلسة السوق.
 *
 * data.json هو المرجع المنشور (يحدّثه GitHub Actions)، لكن الجدولة قد تتأخر.
 * لذلك يقرأ المتصفح أسعار TradingView المؤرخة بالجلسة الحالية ويضعها في الذاكرة
 * مع وسم واضح بأنها متأخرة وغير مؤكدة رسميًا. عند فشل الاتصال يبقى عرض data.json كما هو.
 */
const fetchTimed = (input, options, milliseconds) => Promise.race([
  fetch(input, options),
  new Promise((_, reject) => setTimeout(() => reject(Error('انتهت مهلة الطلب')), milliseconds))
]);
function liveDate(){
  return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
// أحدث جلسة (اثنين–جمعة) فُتحت (9:30 نيويورك). العطل الرسمية غير مُمثَّلة: فيها لا يوجد سعر أحدث فلا يتغير شيء.
function latestSessionDate(now=new Date()){
  for(let back=0;back<8;back++){
    const day=new Date(now.getTime()-back*864e5);
    const part=etParts(day);
    const minutes=Number(part('hour'))*60+Number(part('minute'));
    if(['Sat','Sun'].includes(part('weekday')) || (back===0 && minutes<9*60+30)) continue;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  return liveDate();
}
function snapshotNeedsLiveQuotes(snapshot){
  return isMarketHours() || snapshot?.priceSource?.mode!=='close' || !(String(snapshot?.asOf||'')>=latestSessionDate());
}
function acceptsLiveDate(snapshot, observedDate){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(observedDate||'') || observedDate>liveDate()) return false;
  const asOf=String(snapshot?.asOf||'');
  if(isMarketHours() && observedDate===liveDate()) return true;
  return observedDate>asOf || (observedDate===asOf && snapshot?.priceSource?.mode!=='close');
}
async function getTradingViewLiveQuotes(tvSymbols, accept=date=>date===liveDate()){
  const unique=[...new Set(tvSymbols.filter(Boolean))], result=new Map();
  const columns=['close','change','currency','time','update_mode','market_cap_basic','Value.Traded','change_abs','volume'];
  for(let i=0;i<unique.length;i+=300){
    const tickers=unique.slice(i,i+300);
    try{
      const response=await fetchTimed('https://scanner.tradingview.com/america/scan',{
        method:'POST', mode:'cors', cache:'no-store',
        headers:{'Content-Type':'text/plain;charset=UTF-8',Accept:'application/json'},
        body:JSON.stringify({symbols:{tickers,query:{types:[]}},columns}),
      }, 12000);
      if(!response.ok) continue;
      const payload=await response.json();
      for(const row of payload.data||[]){
        const tv=String(row.s||'');
        const [price,day,currency,barTime,updateMode,marketCap,tradedValue,pointChange,volume]=row.d||[];
        const observedDate=barTime!=null && barTime!=='' && Number.isFinite(Number(barTime))
          ? new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Number(barTime)*1000)) : null;
        if(!unique.includes(tv) || !(Number(price)>0) || !Number.isFinite(Number(day)) ||
           (currency && currency!=='USD') || !accept(observedDate)) continue;
        result.set(tv,{price:Number(price),day:Number(day),marketCap:Number(marketCap),
          updateMode: String(updateMode||'delayed'), tradedValue:Number(tradedValue), volume:volume==null||volume===''?NaN:Number(volume), date:observedDate,
          pointChange:pointChange==null||pointChange===''||!Number.isFinite(Number(pointChange))?null:Number(pointChange)});
      }
    }catch(error){ /* يبقى عرض data.json */ }
  }
  return result;
}
async function applyTradingViewLivePrices(snapshot){
  if(!snapshotNeedsLiveQuotes(snapshot) || !snapshot?.sectors?.length) return false;
  const stocks=snapshot.sectors.flatMap(sector=>sector.stocks);
  const all=await getTradingViewLiveQuotes([INDEX_TV,...stocks.map(stock=>stock.tvSymbol)], observed=>acceptsLiveDate(snapshot, observed));
  // جلسة واحدة فقط: لا نخلط أسعار يومين مختلفين.
  const date=[...all.values()].map(quote=>quote.date).sort().at(-1);
  const quotes=new Map([...all].filter(([,quote])=>quote.date===date));
  const index=quotes.get(INDEX_TV);
  let changed=0, turnover=0, turnoverStocks=0;
  const checkedAt=new Date().toISOString(), inSession=isMarketHours() && date===liveDate();
  for(const stock of stocks){
    const quote=quotes.get(stock.tvSymbol);
    if(!quote) continue;
    stock.price=quote.price;
    stock.day=quote.day;
    if(Number.isFinite(quote.marketCap) && quote.marketCap>0) stock.marketCap=quote.marketCap/1e9;
    if(Number.isFinite(quote.tradedValue) && quote.tradedValue>=0){ stock.tradedValue=quote.tradedValue; turnover+=quote.tradedValue; turnoverStocks++; }
    if(Number.isFinite(quote.volume) && quote.volume>=0) stock.volume=Math.round(quote.volume);
    stock.priceDate=date;
    stock.priceCheckedAt=checkedAt;
    stock.priceTimestamp=null;
    stock.priceSource='TradingView';
    stock.priceStatus='delayed';
    stock._livePrice=true;
    changed++;
  }
  if(index){
    snapshot.marketSummary={...snapshot.marketSummary,
      value:index.price, pointChange:index.pointChange, day:index.day, date:displayDate(date), source:'TradingView', mode:'delayed',
      isIntraday:inSession, updatedAt:checkedAt};
  }
  if(turnoverStocks){
    snapshot.marketSummary={...snapshot.marketSummary, turnover, turnoverSource:'TradingView',
      turnoverEstimated:turnoverStocks<stocks.length, turnoverStocks, turnoverUpdatedAt:checkedAt};
  }
  if(changed || index){
    snapshot.priceSource={...snapshot.priceSource, provider:'TradingView', mode:'delayed',
      observedDate:date, checkedAt, live:true, liveSymbols:changed, liveTurnover:turnover, liveTurnoverStocks:turnoverStocks,
      delayMinutes:inSession?15:null,
      warning:inSession
        ? 'أسعار TradingView المتأخرة (نحو 15 دقيقة) مؤرخة بجلسة اليوم وغير مؤكدة رسميًا كإغلاق؛ ستُستبدل بالإغلاق عند انتهاء الجلسة.'
        : `أسعار نهاية جلسة ${displayDate(date)} من TradingView، غير مؤكدة رسميًا كإغلاق نهائي.`};
    snapshot.priceDate=displayDate(date);
    snapshot.asOf=date;
    return true;
  }
  return false;
}
async function refreshPrices(){
  if(pricesRefreshRunning)return false;
  pricesRefreshRunning=true;
  try{
    const response=await fetch(`data.json?v=${Date.now()}`,{cache:'no-store'});
    if(!response.ok)throw Error(`HTTP ${response.status}`);
    const result=await response.json();
    if(!result||!Array.isArray(result.sectors)||result.sectors.some(sector=>!Array.isArray(sector.stocks)))throw Error('invalid price data');
    // نقارن بوقت فحص النسخة المنشورة (لا بوقت آخر تحديث حي) حتى يستمر التحديث الحي كل دقيقة.
    const current=timestamp(data?._published),incoming=timestamp(result.priceSource?.checkedAt);
    if(data && Number.isFinite(current) && (!Number.isFinite(incoming)||incoming<current)){
      priceRefreshError='رُفضت نسخة أسعار أقدم أو بلا وقت فحص صالح؛ احتُفظ بالقيم المعروضة.';
      paintPriceStatus();
      return false;
    }
    const initial=!data;
    result._published=result.priceSource?.checkedAt;
    data=result;
    priceRefreshError='';
    // فشل المسار المباشر لا يمنع عرض آخر لقطة موثوقة من data.json ولا يغيّرها.
    live.baseIndex=null;
    const realtimeApplied=applyLiveCache(data);
    if(!LQ()&&snapshotNeedsLiveQuotes(data)){
      try{
        const liveUpdated=await applyTradingViewLivePrices(data);
        // خارج الجلسة غياب سعر أحدث أمر طبيعي (عطلة نهاية الأسبوع أو عطلة رسمية).
        if(!liveUpdated && isMarketHours()) priceRefreshError='تعذر الحصول على أسعار مباشرة من TradingView؛ احتُفظ بلقطة المصدر المنشورة.';
      }
      catch(error){ if(isMarketHours()) priceRefreshError='تعذر تحديث السعر المباشر؛ احتُفظ بلقطة المصدر المنشورة.'; }
    }
    if(initial)$('empty').querySelector('h3').textContent='لا توجد نتائج مطابقة';
    paintSnapshot();paintMarketSummary();paintShariahNote();globalThis.MarketMovers?.paint(data);applyFinancials();
    if(initial){
      const updated=allStocks().filter(s=>s._hasCurrentEps).length;
      updateStatus(`ربحية ${updated} سهمًا (مخففة، آخر 12 شهرًا)؛ ${allStocks().length-updated} سهمًا بلا ربحية متاحة. عائد التوزيع لآخر 12 شهرًا من تريدينغ فيو.`);
    }
    return true;
  }catch(error){
    priceRefreshError=data?'تعذر تحديث الأسعار؛ احتُفظ بالقيم المعروضة وستُعاد المحاولة تلقائيًا.':'تعذر تحميل الأسعار؛ ستُعاد المحاولة تلقائيًا.';
    if(data)paintPriceStatus();
    if(!data){$('result-count').textContent='تعذر تحميل البيانات';$('empty').hidden=false;$('empty').querySelector('h3').textContent='تعذر تحميل البيانات';}
    return false;
  }finally{pricesRefreshRunning=false;}
}


/*
 * أسعار لحظية (Nasdaq Last Sale عبر وسيط Cloudflare Worker — انظر worker/README.md).
 * تُجلب كل الأسهم كل 3 ثوانٍ (دفعات من 100 رمز إلى الوسيط، وهو يجلبها من ناسداك 20 رمزًا في الطلب).
 * عند تعطل الوسيط يبقى العرض على data.json وأسعار TradingView المتأخرة كما كان.
 */
const live={cache:new Map(),cursor:0,running:false,timer:null,baseIndex:null};
const LQ=()=>globalThis.LiveQuotes?.enabled?globalThis.LiveQuotes:null;
function applyLiveCache(snapshot){
  if(!snapshot?.sectors||!live.cache.size)return false;
  let changed=0,turnover=0,turnoverStocks=0,date=null,status=null;
  const stocks=snapshot.sectors.flatMap(sector=>sector.stocks);
  for(const stock of stocks){
    const quote=live.cache.get(stock.symbol);
    if(!quote)continue;
    stock.price=quote.price;
    if(Number.isFinite(quote.pct))stock.day=quote.pct;
    if(Number.isFinite(stock.shares)&&stock.shares>0)stock.marketCap=quote.price*stock.shares/1e9;
    if(Number.isFinite(quote.volume)&&quote.volume>0){stock.volume=Math.round(quote.volume);stock.tradedValue=quote.volume*quote.price;}
    date=LiveQuotes.dateOf(quote)||date;status=quote.status||status;
    stock.priceDate=LiveQuotes.dateOf(quote)||stock.priceDate;
    stock.priceCheckedAt=new Date().toISOString();
    stock.priceSource='Nasdaq';
    stock.priceStatus=quote.status==='Closed'?'close':'realtime';
    stock._livePrice=true;
    changed++;
  }
  for(const stock of stocks){if(stock.tradedValue>0){turnover+=stock.tradedValue;turnoverStocks++;}}
  if(!changed)return false;
  const mode=status==='Closed'?'close':'realtime',checkedAt=new Date().toISOString();
  snapshot.marketStatus=status;
  snapshot.priceSource={...snapshot.priceSource,provider:'Nasdaq',mode,observedDate:date||snapshot.priceSource?.observedDate,checkedAt,delayMinutes:null,live:true,liveSymbols:changed,warning:null};
  if(date){snapshot.priceDate=displayDate(date);snapshot.asOf=date;}
  const spy=live.cache.get('SPY');
  if(spy&&Number.isFinite(spy.pct)){
    // ناسداك لا يعطي مؤشر S&P 500 نفسه: نقدّره من حركة صندوق SPY على إغلاق اليوم السابق.
    const m=snapshot.marketSummary||{};
    if(!live.baseIndex&&Number.isFinite(m.value)){
      const snapDate=m.performanceDate||snapshot.asOf,spyDate=LiveQuotes.dateOf(spy);
      live.baseIndex=spyDate&&snapDate&&spyDate>snapDate?m.value:m.value/(1+(m.day||0)/100);
    }
    if(live.baseIndex){
      const value=live.baseIndex*(1+spy.pct/100);
      snapshot.marketSummary={...m,value,pointChange:value-live.baseIndex,day:spy.pct,date:displayDate(date)||m.date,source:'Nasdaq',mode,isIntraday:mode==='realtime',updatedAt:checkedAt,indexEstimated:true};
    }
  }
  snapshot.marketSummary={...snapshot.marketSummary,turnover,turnoverSource:'Nasdaq',turnoverEstimated:true,turnoverStocks,turnoverUpdatedAt:checkedAt};
  return true;
}
function paintLive(){
  paintSnapshot();paintMarketSummary();globalThis.MarketMovers?.paint(data);
  const scrolls=[...document.querySelectorAll('.table-wrap')].map(wrap=>wrap.scrollLeft);
  applyFinancials();
  document.querySelectorAll('.table-wrap').forEach((wrap,i)=>{if(scrolls[i])wrap.scrollLeft=scrolls[i];});
}
async function liveTick(){
  const lq=LQ();
  if(!lq||!data||live.running||document.hidden)return;
  live.running=true;
  try{
    // كل الأسهم في كل دورة: الوسيط يجلبها بدفعات من 20 سهمًا في طلب واحد لدى ناسداك
    const symbols=allStocks().map(stock=>stock.symbol).sort();
    const quotes=await lq.quotes([...symbols,'SPY']);
    for(const [symbol,quote]of quotes)live.cache.set(symbol,quote);
    if(quotes.size&&applyLiveCache(data))paintLive();else paintPriceStatus();
  }finally{live.running=false;}
}
function scheduleLive(){
  clearTimeout(live.timer);
  const lq=LQ();
  if(!lq)return;
  live.timer=setTimeout(async()=>{await liveTick();scheduleLive();},lq.isExtendedHours()?3000:60000);
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&LQ()){liveTick().then(scheduleLive);}});

document.addEventListener('click',event=>{
  const favButton=event.target.closest('[data-fav]');
  if(favButton){event.preventDefault();toggleFavorite(favButton.dataset.fav);return;}
  const favoritesButton=event.target.closest('[data-favorites]');
  if(favoritesButton){favoritesView=true;activeSector=null;sectorGroup=null;if(!sortBySector.has('fav'))sortBySector.set('fav',{key:'marketCap',dir:-1});render();return;}
  const groupButton=event.target.closest('[data-group]');
  if(groupButton){favoritesView=false;sectorGroup=Number(groupButton.dataset.group);activeSector=null;sortBySector.set('all',{key:'marketCap',dir:-1});render();return;}
  const sectorButton=event.target.closest('[data-sector]');
  if(sectorButton){favoritesView=false;activeSector=sectorButton.dataset.sector==='all'?null:Number(sectorButton.dataset.sector);if(activeSector===null){sectorGroup=null;sortBySector.set('all',{key:'marketCap',dir:-1});}render();return;}
  const sortButton=event.target.closest('[data-sort]');
  if(sortButton){const index=['all','fav'].includes(sortButton.dataset.index)?sortButton.dataset.index:Number(sortButton.dataset.index),key=sortButton.dataset.sort,current=sortBySector.get(index);sortBySector.set(index,{key,dir:current?.key===key?-current.dir:1});const section=document.getElementById(`sector-${index}`);const scroll=section.querySelector('.table-wrap').scrollLeft;render();document.getElementById(`sector-${index}`).querySelector('.table-wrap').scrollLeft=scroll;}
});
$('search').addEventListener('input',event=>{query=normalized(event.target.value);render();});
$('clear').addEventListener('click',()=>{$('search').value='';query='';render();$('search').focus();});
$('recurring-mode').addEventListener('click',()=>updateMode('recurring'));
$('reported-mode').addEventListener('click',()=>updateMode('reported'));
refreshPrices().then(()=>{if(LQ()){liveTick().then(scheduleLive);}});
setInterval(refreshPrices,60*1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshPrices();});
