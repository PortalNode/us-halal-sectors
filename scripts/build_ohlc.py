#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""شموع يومية من 2010-01-01 إلى آخر جلسة لكل سهم في data.json (+ مؤشر S&P 500 المرجعي).

المصدر: واجهتا Nasdaq العامتان اللتان تغذيان nasdaq.com:
  * quote/<الرمز>/historical  آخر 10 سنوات، والمخرجات معدّلة للتجزئة أصلًا (أسعارًا وحجمًا)
  * quote/<الرمز>/chart        بدايات 2010 حتى ما قبل ذلك، معدّلة للتجزئة أيضًا
لا نطبّق أي تعديل للتجزئة هنا: كشف التجزئة من القفزات السعرية كان يخلق تعديلات خاطئة (قفزة أرباح تُحسب تجزئة 1.5:1)
فتختلف الشموع عن TradingView. الشموع هنا معدّلة للتجزئة وغير معدّلة للتوزيعات، وهو الوضع الافتراضي في TradingView.
المؤشر S&P 500 من Cboe (بلا حجم).

ohlc/<الرمز>.json          الجلسات الحديثة (بعد حد التاريخ historyThrough)، يتحدث يوميًا
ohlc/history/<الرمز>.json  ما قبل ذلك منذ 2010، يُكتب عند غيابه أو تغيّر حد التاريخ (مرة كل سنة) أو عند ظهور تجزئة جديدة

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


def nasdaq_recent(symbol, cls, end):
    data = get_json(HISTORICAL.format(sym=symbol, cls=cls, start=START, end=end))
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


def pack(symbol, rows, source, official_through, dividends=None, history_through=None):
    out = {"symbol": symbol, "source": source, "officialThrough": official_through, "est": [],
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


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    full = "--full" in sys.argv
    with open(os.path.join(ROOT, "data.json"), encoding="utf-8") as handle:
        data = json.load(handle)
    listed = [s["symbol"] for sector in data["sectors"] for s in sector["stocks"]]
    symbols = args or listed + [data["marketSummary"]["indexSymbol"]]
    mode = data["priceSource"]["mode"]
    now = datetime.now(NY)
    boundary = history_boundary(now)
    end = now.strftime("%Y-%m-%d")
    missing, rewritten = [], 0
    for symbol in symbols:
        is_index = symbol == INDEX_SYMBOL
        path = os.path.join(ROOT, "ohlc", f"{symbol}.json")
        hist_path = os.path.join(ROOT, "ohlc", "history", f"{symbol}.json")
        old_recent, old_history = read(path), read(hist_path)
        if is_index:
            rows, how = cboe_index(), "Cboe (مؤشر S&P 500)"
        else:
            rows, how = [], "Nasdaq (معدّل للتجزئة)"
            for cls in ("stocks", "etf"):
                rows = nasdaq_recent(symbol, cls, end)
                time.sleep(0.35)
                if rows:
                    break
            else:
                cls = "stocks"
        if not rows:
            missing.append(symbol)
            continue
        source = f"{how} · " + ("إغلاق الجلسة" if mode == "close" else "شموع متأخرة")
        dividends = (old_recent or {}).get("div") or []
        last = rows[-1][0]
        through = last if mode == "close" else (rows[-2][0] if len(rows) > 1 else last)
        recent_rows = [r for r in rows if r[0] > boundary]
        keep_history = (not full and old_history and old_recent and old_recent.get("historyThrough") == boundary
                        and history_matches(old_history, rows))
        if keep_history:
            history_rows = None
        elif is_index:
            history_rows = [r for r in rows if r[0] <= boundary]
        else:
            first_recent = rows[0][0]
            early = nasdaq_early(symbol, cls, first_recent)
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
    print(f"تم: {len(symbols) - len(missing)}/{len(symbols)} · الجلسة الأخيرة {data['asOf']} · ملفات تاريخ أُعيدت كتابتها: {rewritten}")
    if missing:
        print("بلا شموع:", missing)


if __name__ == "__main__":
    main()
