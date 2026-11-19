#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""يقارن شموع ohlc/ بأرقام TradingView الرسمية في ماسحه (السعر الأخير، أعلى/أدنى 52 أسبوعًا، الأداء لسنة و3 و5 و10 سنوات،
وحجم آخر جلسة). كل رقم من هذه محسوب عند TradingView على أسعار معدّلة للتجزئة، فاختلاف الشموع عنه يكشف تعديلًا خاطئًا.

    python3 scripts/check_candles.py            # كل الأسهم
    python3 scripts/check_candles.py AAPL NVDA  # أسهم محددة
"""
import bisect
import json
import os
import sys
import urllib.request
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
COLS = ["name", "close", "volume", "price_52_week_high", "price_52_week_low", "Perf.Y", "Perf.3Y", "Perf.5Y", "Perf.10Y"]
PRICE_TOLERANCE = 0.015  # فرق تاريخ يوم واحد بين طريقة حساب الأداء عندنا وعندهم يحرّك السعر عادة أقل من 1.5%


def candles(symbol):
    recent = json.load(open(os.path.join(ROOT, "ohlc", f"{symbol}.json"), encoding="utf-8"))
    if recent.get("historyThrough"):
        older = json.load(open(os.path.join(ROOT, "ohlc", "history", f"{symbol}.json"), encoding="utf-8"))
        for key in "dohlcv":
            recent[key] = older[key] + recent[key]
    return recent


def main():
    data = json.load(open(os.path.join(ROOT, "data.json"), encoding="utf-8"))
    listed = [s["symbol"] for sec in data["sectors"] for s in sec["stocks"]]
    symbols = sys.argv[1:] or listed
    body = json.dumps({"filter": [{"left": "name", "operation": "in_range", "right": symbols}, {"left": "type", "operation": "equal", "right": "stock"}],
                       "columns": COLS, "range": [0, 700]}).encode()
    req = urllib.request.Request("https://scanner.tradingview.com/america/scan", body, {"User-Agent": UA, "Content-Type": "application/json"})
    tv = {}
    for item in json.load(urllib.request.urlopen(req, timeout=60))["data"]:
        record = dict(zip(COLS, item["d"]))
        tv.setdefault(record["name"], record)
    session = data["asOf"]
    problems, checked, volume_ratios = [], 0, []
    for symbol in symbols:
        t = tv.get(symbol)
        if not t:
            continue
        try:
            f = candles(symbol)
        except OSError:
            problems.append((symbol, "لا ملف شموع"))
            continue
        d, c = f["d"], f["c"]
        checked += 1
        if d[-1] != session:
            problems.append((symbol, f"آخر شمعة {d[-1]} وليست {session}"))
        if abs(c[-1] / t["close"] - 1) > 0.002:
            problems.append((symbol, f"الإغلاق {c[-1]} مقابل TradingView {t['close']}"))
        if d[-1] == session and t.get("volume"):
            volume_ratios.append(f["v"][-1] / t["volume"])
        year, month_day = int(session[:4]), session[4:]
        for years, field in ((1, "Perf.Y"), (3, "Perf.3Y"), (5, "Perf.5Y"), (10, "Perf.10Y")):
            perf = t.get(field)
            if perf is None:
                continue
            target = f"{year - years}{month_day}"
            i = bisect.bisect_right(d, target) - 1
            if i < 0 or d[i] < f"{year - years}{month_day[:3]}01":
                continue
            implied = t["close"] / (1 + perf / 100)  # سعر TradingView قبل المدة
            if abs(c[i] / implied - 1) > PRICE_TOLERANCE:
                problems.append((symbol, f"قبل {years} سنوات: شمعتنا {c[i]} مقابل {implied:.4f} عند TradingView ({d[i]})"))
        # الأعلى والأدنى لـ52 أسبوعًا (نافذة تقويمية)
        cut = (date.fromisoformat(f"{year - 1}{month_day}") + timedelta(days=2)).isoformat()  # نافذة TradingView تبدأ بعد يومين من تاريخ المقارنة السنوي
        j = bisect.bisect_left(d, cut)
        hi, lo = max(f["h"][j:]), min(f["l"][j:])
        if t["price_52_week_high"] and abs(hi / t["price_52_week_high"] - 1) > 0.01:
            problems.append((symbol, f"أعلى 52 أسبوعًا {hi} مقابل {t['price_52_week_high']}"))
        if t["price_52_week_low"] and abs(lo / t["price_52_week_low"] - 1) > 0.01:
            problems.append((symbol, f"أدنى 52 أسبوعًا {lo} مقابل {t['price_52_week_low']}"))
    print(f"فُحص {checked} سهمًا · الملاحظات: {len(problems)}")
    for symbol, text in problems:
        print(f"  {symbol}: {text}")
    if volume_ratios:
        volume_ratios.sort()
        print(f"نسبة حجم آخر جلسة عندنا إلى TradingView: الوسيط {volume_ratios[len(volume_ratios)//2]:.3f} · أدنى {volume_ratios[0]:.3f} · أعلى {volume_ratios[-1]:.3f}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
