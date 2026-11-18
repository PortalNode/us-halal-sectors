# السوق الأمريكي الشرعي

نسخة للأسهم الأمريكية المتوافقة مع الضوابط الشرعية من موقع «قطاعات السوق السعودي»
(<https://portalnode.github.io/saudi-sectors/>) بالبنية والواجهة نفسها: ملخص السوق، حركة السوق (أعلى 10)،
جدول الشركات حسب القطاعات مع الأعمدة والترتيب والبحث والمفضلة، ثم صفحات «نتائج الشركات» و«مقارنة النتائج المالية» و«التحليل الفني».

## مصادر البيانات
| ما | المصدر |
|---|---|
| قائمة الشركات الشرعية | حيازات صندوق **SPUS** (SP Funds S&P 500 Sharia Industry Exclusions ETF) المتتبع لمؤشر S&P 500 Shariah؛ ملف CSV منشور يوميًا من SP Funds |
| الأسعار والتقييم والأداء والنتائج المالية | TradingView Scanner (America) |
| الشموع اليومية (شارت التحليل الفني) | Yahoo Finance (chart API) |
| الشعارات | TradingView |
| المؤشر المرجعي | سعر صندوق SPUS (لا يوجد مؤشر S&P 500 Shariah مجاني بيانات مباشرة) |

> هذه المعلومات للاطلاع وليست فتوى. قد تخرج شركة من القائمة أو تدخل عند إعادة موازنة المؤشر؛ تحقق من توافق السهم مع مرجعك الشرعي، وطهّر أي أرباح موزعة حسب ضوابط جهتك.

## التشغيل محليًا
```bash
python3 scripts/build_data.py   # data.json + financials.json + logos/
python3 scripts/build_ohlc.py   # ohlc/*.json (بطيء عمدًا لتفادي حظر Yahoo، ~6 دقائق)
python3 -m http.server 8000     # ثم افتح http://localhost:8000
```
بايثون 3.9+ بلا مكتبات خارجية.

## النشر والتحديث
ارفع المجلد إلى مستودع GitHub وفعّل GitHub Pages. ملف `.github/workflows/update-data.yml` يحدّث الأسعار كل 15 دقيقة
أثناء الجلسة، والشموع مرة بعد الإغلاق. أثناء الجلسة يقرأ المتصفح أسعار TradingView مباشرة (متأخرة نحو 15 دقيقة).

## الملفات
- `index.html` + `app.js` + `market-movers.js`: الصفحة الرئيسية
- `company.html` + `company.js` + `company-quote.js`: نتائج الشركات والنبذة وبطاقة السهم
- `comparison.html` + `comparison-page.js`: مقارنة النتائج السنوية بين شركات القطاع
- `technical-analysis.html` + `company-chart.js`: الشارت (Lightweight Charts، Apache-2.0)
- `scripts/`: توليد البيانات (`arabic_names.py` أسماء الشركات والقطاعات بالعربية)
