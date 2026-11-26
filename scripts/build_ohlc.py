#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""شموع يومية من 2010-01-01 إلى آخر جلسة لكل سهم في data.json (+ مؤشر S&P 500 المرجعي).

المصدر: واجهتا Nasdaq العامتان اللتان تغذيان nasdaq.com:
  * quote/<الرمز>/historical  آخر 10 سنوات، والمخرجات معدّلة للتجزئة أصلًا (أسعارًا وحجمًا)
  * quote/<الرمز>/chart        بدايات 2010 حتى ما قبل ذلك، معدّلة للتجزئة أيضًا
لا نطبّق أي تعديل للتجزئة هنا: كشف التجزئة من القفزات السعرية كان يخلق تعديلات خاطئة (قفزة أرباح تُحسب تجزئة 1.5:1)
فتختلف الشموع عن TradingView. الشموع هنا معدّلة للتجزئة وغير معدّلة للتوزيعات، وهو الوضع الافتراضي في TradingView.
المؤشر S&P 500 من Cboe (بلا حجم)، وتُضاف إليه شمعة كل جلسة من TradingView (marketSummary.ohlc) متى كانت أحدث،
لأن Cboe يحجب الطلبات الآلية منذ نوفمبر 2026.

ohlc/<الرمز>.json          الجلسات الحديثة (بعد حد التاريخ historyThrough)، يتحدث يوميًا
ohlc/history/<الرمز>.json  ما قبل ذلك منذ 2010، يُكتب عند غيابه أو تغيّر حد التاريخ (مرة كل سنة) أو عند ظهور تجزئة جديدة

شمعة الجلسة بعد الإغلاق (كالسوق السعودي): من ماسح TradingView بعد 16:20 بتوقيت نيويورك، شمعة الجلسة والجلسة التي قبلها
(الافتتاح والإغلاق مزادا الافتتاح والإغلاق الرسميان، والنطاق والحجم مجمّعة)، فتدخل الملف بعد الإغلاق بدقائق لا ساعات،
وتُعاد كل دورة حتى نهاية اليوم ولا يُكتب الملف إلا إن تغيّر. إن اختلفت شمعة الجلسة السابقة عن المخزّنة بمعامل واحد للشمعة
كلها فهي تجزئة جديدة: يعاد بناء شموع السهم من ناسداك. وناسداك أيضًا يملأ الجلسات التي فاتت التحديث (آخر 45 يومًا)،
ويبني سهمًا جديدًا أو تاريخًا تغيّر حده. إن تعذر TradingView بقي المسار القديم: ناسداك وحده متى نشر شمعة الجلسة.

    python3 scripts/build_ohlc.py              # كل الأسهم
    python3 scripts/build_ohlc.py AAPL MSFT    # أسهم محددة
    python3 scripts/build_ohlc.py --full       # يعيد كتابة ملفات التاريخ كلها
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NY = ZoneInfo("America/New_York")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
START = "2010-01-01"
INDEX_SYMBOL = "SPX"  # المؤشر المرجعي (يطابق marketSummary.indexSymbol في data.json)
HISTORICAL = "https://api.nasdaq.com/api/quote/{sym}/historical?assetclass={cls}&fromdate={start}&limit=5000&todate={end}"
CHART = "https://api.nasdaq.com/api/quote/{sym}/chart?assetclass={cls}&fromdate={start}&todate={end}"
CBOE_SPX = "https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/_SPX.json"
TV_SCAN = "https://scanner.tradingview.com/america/scan"
# شمعة الجلسة والجلسة السابقة كما يعرضهما TradingView (الافتتاح والإغلاق مزادا الافتتاح والإغلاق الرسميان، والنطاق والحجم مجمّعة من كل المنصات)
TV_COLUMNS = ["name", "time", "open", "high", "low", "close", "volume",
              "time[1]", "open[1]", "high[1]", "low[1]", "close[1]", "volume[1]", "currency"]
# TradingView متأخر 15 دقيقة للطلبات المجهولة: لا تُعتمد شمعة الجلسة قبل 16:20 بتوقيت نيويورك
SETTLE_MINUTES = 16 * 60 + 20
SPLIT_TOLERANCE = 0.004  # التجزئة تحرّك الشمعة كلها بمعامل واحد؛ اختلاف الإغلاق وحده تصحيح


def get_json(url, timeout=60, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return None


def money(text):
    try:
        return float(str(text).replace("$", "").replace(",", "").strip())
    except ValueError:
        return None


def volume(text):
    digits = str(text or "").replace(",", "").strip()
    return int(float(digits)) if digits.replace(".", "", 1).isdigit() else 0


def clean(rows):
    """تاريخ → شمعة واحدة، مرتبة، وبلا شموع غير منطقية (أسعار غير موجبة أو قمة دون قاع)."""
    by_date = {}
    for date, o, h, l, c, v in rows:
        if None in (o, h, l, c) or min(o, h, l, c) <= 0 or h < l:
            continue
        # بعض الأسعار المعدّلة تخرج من المصدر بخلاف بسيط بين الافتتاح/الإغلاق والقمة/القاع
        h, l = max(h, o, c), min(l, o, c)
        by_date[date] = (date, round(o, 4), round(h, 4), round(l, 4), round(c, 4), v)
    return [by_date[d] for d in sorted(by_date)]


def nasdaq_recent(symbol, cls, end, start=START):
    data = get_json(HISTORICAL.format(sym=symbol, cls=cls, start=start, end=end))
    table = ((data or {}).get("data") or {}).get("tradesTable") or {}
    rows = []
    for x in table.get("rows") or []:
        try:
            m, d, y = x["date"].split("/")
            rows.append((f"{y}-{m}-{d}", money(x["open"]), money(x["high"]), money(x["low"]), money(x["close"]), volume(x.get("volume"))))
        except (ValueError, KeyError):
            continue
    return clean(rows)


def nasdaq_early(symbol, cls, before):
    """شموع 2010 حتى اليوم السابق لـ before (واجهة chart)."""
    end = (datetime.strptime(before, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    if end < START:
        return []
    data = get_json(CHART.format(sym=symbol, cls=cls, start=START, end=end))
    rows = []
    for x in ((data or {}).get("data") or {}).get("chart") or []:
        z = x.get("z") or {}
        try:
            m, d, y = z["dateTime"].split("/")
            rows.append((f"{y}-{int(m):02d}-{int(d):02d}", money(z["open"]), money(z["high"]), money(z["low"]), money(z["close"]), volume(z.get("volume"))))
        except (ValueError, KeyError):
            continue
    return clean(rows)


def cboe_index():
    """مؤشر S&P 500 نفسه (لا صندوقًا): شموع يومية من Cboe، لا حجم فيها (الحجم 0)."""
    data = (get_json(CBOE_SPX) or {}).get("data")
    rows = []
    for x in data or []:
        try:
            o, h, l, c = (money(x[k]) for k in ("open", "high", "low", "close"))
        except KeyError:
            continue
        if x["date"] >= START:
            rows.append((x["date"], o, h, l, c, 0))
    return clean(rows)


def with_session_bar(rows, bar):
    """يضيف شمعة آخر جلسة للمؤشر من data.json (marketSummary.ohlc، من TradingView) إن كانت أحدث وكاملة.
    يرجع (الشموع، هل أُضيفت)."""
    if bar and all(bar.get(k) for k in ("open", "high", "low", "close")) and (not rows or bar["date"] > rows[-1][0]):
        return clean(rows + [(bar["date"], bar["open"], bar["high"], bar["low"], bar["close"], 0)]), True
    return rows, False


def tv_bar(t, o, h, l, c, v):
    """شمعة TradingView صالحة (تاريخ الجلسة بتوقيت نيويورك، أسعار موجبة متسقة، حجم موجب) أو None."""
    if not isinstance(t, (int, float)) or not all(isinstance(x, (int, float)) and x > 0 for x in (o, h, l, c)):
        return None
    if not (isinstance(v, (int, float)) and v > 0) or h < max(o, c) * 0.9999 or l > min(o, c) * 1.0001:
        return None
    date = datetime.fromtimestamp(t, timezone.utc).astimezone(NY).strftime("%Y-%m-%d")
    return (date, round(o, 4), round(max(h, o, c), 4), round(min(l, o, c), 4), round(c, 4), int(round(v)))


def tv_row(values):
    """صف الماسح (أعمدة TV_COLUMNS) → {"today": شمعة, "prev": شمعة} أو None إن لم تكن العملة دولارًا."""
    _, t, o, h, l, c, v, t1, o1, h1, l1, c1, v1, currency = (list(values) + [None] * 14)[:14]
    if currency and currency != "USD":
        return None
    return {"today": tv_bar(t, o, h, l, c, v), "prev": tv_bar(t1, o1, h1, l1, c1, v1)}


def tv_sessions(stocks):
    """{الرمز: {"today", "prev"}} من ماسح TradingView لكل الأسهم (دفعات من 100). فشل الماسح → {}."""
    out = {}
    tickers = {(s.get("tvSymbol") or f"{s.get('exchange') or 'NASDAQ'}:{s['symbol']}"): s["symbol"] for s in stocks}
    names = list(tickers)
    for i in range(0, len(names), 100):
        body = json.dumps({"symbols": {"tickers": names[i:i + 100], "query": {"types": []}}, "columns": TV_COLUMNS}).encode()
        data = None
        for attempt in range(3):
            try:
                req = urllib.request.Request(TV_SCAN, data=body, headers={"User-Agent": UA, "Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = json.load(r)
                break
            except Exception:
                time.sleep(1.5 * (attempt + 1))
        for row in (data or {}).get("data") or []:
            symbol = tickers.get(row.get("s"))
            session = symbol and tv_row(row.get("d") or [])
            if session and session["today"]:
                out[symbol] = session
    return out


def weekdays_between(a, b):
    """أيام العمل (الاثنين–الجمعة) بين تاريخين، دونهما."""
    day, end, n = datetime.strptime(a, "%Y-%m-%d") + timedelta(days=1), datetime.strptime(b, "%Y-%m-%d"), 0
    while day < end:
        n += day.weekday() < 5
        day += timedelta(days=1)
    return n


def add_session(rows, session, session_date, filled=False):
    """يضع شمعتي TradingView (الجلسة session_date والجلسة السابقة لها) مكان المخزّنتين، كما في السوق السعودي.
    يرجع (الشموع، الحالة): "added" أُضيفت، "split" إغلاق الجلسة السابقة تغيّر بمعامل واحد للشمعة كلها
    (تجزئة: يلزم إعادة بناء التاريخ)، "gap" جلسات ناقصة قبل الجلسة السابقة (تُملأ من ناسداك)، None لا شيء."""
    today, prev = (session or {}).get("today"), (session or {}).get("prev")
    if not today or today[0] != session_date or (rows and today[0] < rows[-1][0]):
        return rows, None
    stored = {r[0]: r for r in rows}
    if prev and prev[0] < today[0]:
        old = stored.get(prev[0])
        if old and abs(prev[4] / old[4] - 1) > 0.01:
            ratios = [prev[k] / old[k] for k in (1, 2, 3, 4)]
            if max(ratios) / min(ratios) - 1 <= SPLIT_TOLERANCE:
                return rows, "split"
        before = [r for r in rows if r[0] < prev[0]]
        # الجلسة السابقة غير مخزّنة وبينها وبين آخر شمعة مخزنة يوم عمل أو أكثر: جلسات فاتت التحديث.
        # filled: مُلئت من ناسداك قبل الاستدعاء (ما بقي عطلة رسمية أو جلسة لم ينشرها ناسداك بعد)
        if not filled and not old and before and weekdays_between(before[-1][0], prev[0]) > 0:
            return rows, "gap"
        return clean(before + [prev, today]), "added"
    return clean([r for r in rows if r[0] < today[0]] + [today]), "added"


def pack(symbol, rows, source, official_through, dividends=None, history_through=None, est=None):
    out = {"symbol": symbol, "source": source, "officialThrough": official_through, "est": est or [],
           "div": dividends or [], "flags": []}
    for key, idx in (("d", 0), ("o", 1), ("h", 2), ("l", 3), ("c", 4), ("v", 5)):
        out[key] = [r[idx] for r in rows]
    if history_through:
        out["historyThrough"] = history_through
    return out


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(obj, handle, ensure_ascii=False, separators=(",", ":"))


def read(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def history_boundary(today):
    """آخر يوم في السنة السابقة للسنة السابقة: الملف الحديث ≈ سنة ونصف إلى سنتين، ويتحرك الحد مرة كل سنة."""
    return f"{today.year - 2}-12-31"


def history_matches(history, fresh):
    """تجزئة جديدة تغيّر كل الأسعار السابقة: إن اختلف أي إغلاق مشترك بأكثر من 0.3% نعيد كتابة التاريخ."""
    if not history or not history.get("d"):
        return False
    fresh_close = {r[0]: r[4] for r in fresh}
    shared = [(c, fresh_close[d]) for d, c in zip(history["d"], history["c"]) if d in fresh_close]
    return bool(shared) and all(abs(a / b - 1) <= 0.003 for a, b in shared if b)


def rows_of(file):
    return list(zip(file["d"], file["o"], file["h"], file["l"], file["c"], file["v"]))


def merge_recent(old_rows, fresh):
    """الشموع المخزنة حتى يوم قبل أول يوم جُلب + الشموع المجلوبة، بشرط تطابق الإغلاقات المشتركة (وإلا None = تجزئة جديدة)."""
    if not fresh:
        return None
    stored = {r[0]: r[4] for r in old_rows}
    shared = [(stored[r[0]], r[4]) for r in fresh if r[0] in stored]
    if not shared or any(abs(a / b - 1) > 0.003 for a, b in shared if b):
        return None
    first = fresh[0][0]
    return [r for r in old_rows if r[0] < first] + fresh


def nasdaq_rows(symbol, end, start=START):
    """شموع ناسداك الحديثة (سهم ثم صندوق متداول). يرجع (الشموع، الفئة)."""
    for cls in ("stocks", "etf"):
        rows = nasdaq_recent(symbol, cls, end, start)
        time.sleep(0.35)
        if rows:
            return rows, cls
    return [], "stocks"


def session_settled(now, session_date):
    """هل انتهت الجلسة وتجاوزنا تأخير TradingView (16:20 بتوقيت نيويورك)؟"""
    today = now.strftime("%Y-%m-%d")
    return session_date < today or (session_date == today and now.hour * 60 + now.minute >= SETTLE_MINUTES)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    full = "--full" in sys.argv
    with open(os.path.join(ROOT, "data.json"), encoding="utf-8") as handle:
        data = json.load(handle)
    stocks = [s for sector in data["sectors"] for s in sector["stocks"]]
    listed = [s["symbol"] for s in stocks]
    symbols = args or listed + [data["marketSummary"]["indexSymbol"]]
    mode, session_date = data["priceSource"]["mode"], data["asOf"]
    now = datetime.now(NY)
    boundary = history_boundary(now)
    end = now.strftime("%Y-%m-%d")
    if mode != "close" and not args and not full:
        print("الجلسة جارية: لا تحديث للشموع قبل الإغلاق")
        return
    # شمعة الجلسة من TradingView هي المرجع بعد الإغلاق (مثل السوق السعودي)، وناسداك لملء الجلسات الناقصة وبناء التاريخ
    sessions = {}
    if mode == "close" and session_settled(now, session_date):
        wanted = set(symbols)
        sessions = tv_sessions([s for s in stocks if s["symbol"] in wanted])
        print(f"شموع TradingView لجلسة {session_date}: {sum(1 for x in sessions.values() if x['today'][0] == session_date)}/{len(wanted & set(listed))}")
    elif mode == "close":
        print(f"قبل 16:20 بتوقيت نيويورك: لا تُعتمد شمعة TradingView لجلسة {session_date} بعد (متأخرة 15 دقيقة)")
    missing, rewritten, written, unchanged, splits = [], 0, 0, 0, []
    for symbol in symbols:
        is_index = symbol == INDEX_SYMBOL
        path = os.path.join(ROOT, "ohlc", f"{symbol}.json")
        hist_path = os.path.join(ROOT, "ohlc", "history", f"{symbol}.json")
        old_recent, old_history = read(path), read(hist_path)
        if is_index:
            if not args and not full and old_recent and old_recent.get("d") and old_recent["d"][-1] >= session_date:
                continue
            rows, how = cboe_index(), "Cboe (مؤشر S&P 500)"
            if not rows and old_recent:
                # Cboe يحجب الطلبات الآلية (403 منذ 19 نوفمبر 2026): نُبقي الشموع المخزنة
                rows, how = clean((rows_of(old_history) if old_history else []) + rows_of(old_recent)), "Cboe + TradingView"
            # شمعة آخر جلسة من TradingView تُضاف دائمًا متى كانت أحدث، سواء جاء Cboe متأخرًا أو تعذر
            previous = rows[-1][0] if rows else None
            rows, added = with_session_bar(rows, data["marketSummary"].get("ohlc"))
            if added and "TradingView" not in how:
                how += " + TradingView"
            if added and previous and (datetime.strptime(rows[-1][0], "%Y-%m-%d") - datetime.strptime(previous, "%Y-%m-%d")).days > 4:
                print(f"تنبيه: فجوة في شموع المؤشر بين {previous} و{rows[-1][0]} (تحتاج ملئًا يدويًا)")
            if rows and rows[-1][0] < session_date:
                print("تنبيه: لا شمعة للمؤشر لجلسة", session_date)
            cls = "stocks"
        else:
            session = sessions.get(symbol)
            # ملف حديث يكفي للتحديث السريع: تاريخه محفوظ حتى حد السنة، أو السهم أُدرج بعد الحد فلا تاريخ له
            quick = (not full and old_recent and old_recent.get("d")
                     and ((old_recent.get("historyThrough") == boundary and old_history)
                          or (not old_recent.get("historyThrough") and old_recent["d"][0] > boundary)))
            rows, how, status = None, "Nasdaq + TradingView", None
            if quick:
                # الشموع التقديرية القديمة (نظام سابق) لا تبقى: تحل محلها شمعة TradingView أو ناسداك
                old_est = set(old_recent.get("est") or [])
                rows = [r for r in rows_of(old_recent) if r[0] not in old_est]
                rows, status = add_session(rows, session, session_date)
                if status == "gap" or (status is None and (not rows or rows[-1][0] < session_date)):
                    # جلسات فاتت التحديث (أو لا شمعة من TradingView): آخر 45 يومًا من ناسداك تُدمج في المخزّن
                    fresh, _ = nasdaq_rows(symbol, end, (now - timedelta(days=45)).strftime("%Y-%m-%d"))
                    merged = merge_recent(rows, fresh) if fresh else rows
                    if merged is None:
                        status = "split"
                    else:
                        rows, status = add_session(merged, session, session_date, filled=True)
                        rows = rows if status != "split" else merged
                if status != "split" and rows:
                    if rows == rows_of(old_recent) and not old_est and old_recent.get("officialThrough") == rows[-1][0]:
                        unchanged += 1
                        continue
                    source = how + " · إغلاق الجلسة"
                    through = rows[-1][0] if mode == "close" or len(rows) < 2 else rows[-2][0]
                    dump(path, pack(symbol, rows, source, through, old_recent.get("div") or [],
                                    history_through=old_recent.get("historyThrough")))
                    written += 1
                    continue
                if status == "split":
                    splits.append(symbol)
            # بناء كامل من ناسداك (سهم جديد، أو تغيّر حد التاريخ، أو تجزئة جديدة)، ثم شمعة TradingView فوقه
            rows, cls = nasdaq_rows(symbol, end)
            if rows:
                with_tv, status = add_session(rows, session, session_date, filled=True)
                if status == "added":
                    rows = with_tv
                elif status == "split":
                    print(f"تنبيه: {symbol} شموع ناسداك لم تُعدَّل بعد لتجزئة جديدة؛ تُعاد في الدورة التالية")
        if not rows:
            missing.append(symbol)
            continue
        source = f"{how} · " + ("إغلاق الجلسة" if mode == "close" else "شموع متأخرة")
        dividends = (old_recent or {}).get("div") or []
        last = rows[-1][0]
        through = last if mode == "close" else (rows[-2][0] if len(rows) > 1 else last)
        recent_rows = [r for r in rows if r[0] > boundary]
        keep_history = (not full and symbol not in splits and old_history and old_recent
                        and old_recent.get("historyThrough") == boundary and history_matches(old_history, rows))
        if keep_history:
            history_rows = None
        elif is_index:
            history_rows = [r for r in rows if r[0] <= boundary]
        else:
            early = nasdaq_early(symbol, cls, rows[0][0])
            time.sleep(0.35)
            history_rows = [r for r in early + rows if r[0] <= boundary]
        if history_rows is not None:
            if history_rows:
                dump(hist_path, pack(symbol, history_rows, source, history_rows[-1][0], [d for d in dividends if d[0] <= boundary]))
            elif os.path.exists(hist_path):
                os.remove(hist_path)
            rewritten += 1
        has_history = keep_history or bool(history_rows)
        dump(path, pack(symbol, recent_rows, source, through, [d for d in dividends if d[0] > boundary],
                        history_through=(boundary if has_history else None)))
        written += 1
    print(f"تم: الجلسة {session_date} · ملفات كُتبت {written} · بلا تغيير {unchanged} · ملفات تاريخ أُعيدت كتابتها {rewritten}")
    if splits:
        print("تجزئة جديدة أُعيد بناء شموعها:", splits)
    if missing:
        print("بلا شموع:", missing)


if __name__ == "__main__":
    main()
