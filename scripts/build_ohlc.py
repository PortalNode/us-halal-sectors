#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""شموع يومية من Yahoo Finance لكل سهم في data.json (+ صندوق SPUS كمؤشر مرجعي).

ohlc/<الرمز>.json          آخر ~480 جلسة، يُحدَّث يوميًا (ويحمل historyThrough)
ohlc/history/<الرمز>.json  ما قبلها (5 سنوات في الإجمال)، يُكتب مرة واحدة إن لم يوجد

    python3 scripts/build_ohlc.py            # كل الأسهم
    python3 scripts/build_ohlc.py AAPL MSFT  # أسهم محددة
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NY = ZoneInfo("America/New_York")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
RECENT = 480
HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]


_started = time.time()


def fetch(symbol):
    """طلب واحد بطيء؛ عند الحظر (429) ننتظر دقيقتين ونعيد نفس السهم حتى ساعة كاملة ثم نستسلم."""
    ysym = symbol.replace(".", "-")
    attempt = 0
    while time.time() - _started < 3600 * 2:
        host = HOSTS[attempt % 2]
        attempt += 1
        url = f"https://{host}/v8/finance/chart/{ysym}?range=5y&interval=1d&events=div"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                result = json.load(r)["chart"]["result"][0]
            time.sleep(1.5)  # تهدئة بين الطلبات لتفادي الحظر
            return result
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            time.sleep(120 if error.code == 429 else 10)
        except Exception:
            time.sleep(10)
    return None


def build(symbol):
    result = fetch(symbol)
    if not result or not result.get("timestamp"):
        return symbol, None
    quote = result["indicators"]["quote"][0]
    rows = []
    for i, ts in enumerate(result["timestamp"]):
        o, h, l, c, v = (quote[k][i] for k in ("open", "high", "low", "close", "volume"))
        if None in (o, h, l, c):
            continue
        date = datetime.fromtimestamp(ts, timezone.utc).astimezone(NY).strftime("%Y-%m-%d")
        rows.append((date, round(o, 4), round(h, 4), round(l, 4), round(c, 4), int(v or 0)))
    # يوم مكرر (آخر شمعة لحظية) → نبقي الأخيرة
    unique = {}
    for row in rows:
        unique[row[0]] = row
    rows = [unique[d] for d in sorted(unique)]
    dividends = sorted(
        [datetime.fromtimestamp(int(k), timezone.utc).astimezone(NY).strftime("%Y-%m-%d"), round(v["amount"], 6)]
        for k, v in (result.get("events", {}).get("dividends") or {}).items()
    )
    return symbol, (rows, dividends)


def pack(symbol, rows, dividends, source, official_through, history_through=None):
    out = {"symbol": symbol, "source": source, "officialThrough": official_through, "est": [],
           "div": dividends, "flags": []}
    for key, idx in (("d", 0), ("o", 1), ("h", 2), ("l", 3), ("c", 4), ("v", 5)):
        out[key] = [r[idx] for r in rows]
    if history_through:
        out["historyThrough"] = history_through
    return out


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(obj, handle, ensure_ascii=False, separators=(",", ":"))


def main():
    with open(os.path.join(ROOT, "data.json"), encoding="utf-8") as handle:
        data = json.load(handle)
    symbols = [s["symbol"] for sector in data["sectors"] for s in sector["stocks"]] + [data["marketSummary"]["indexSymbol"]]
    if len(sys.argv) > 1:
        symbols = sys.argv[1:]
    mode = data["priceSource"]["mode"]
    source = "TradingView · إغلاق الجلسة" if mode == "close" else "Yahoo Finance · شموع متأخرة"
    missing = []
    with ThreadPoolExecutor(1) as pool:
        for symbol, built in pool.map(build, symbols):
            if not built:
                missing.append(symbol)
                continue
            rows, dividends = built
            last = rows[-1][0]
            through = last if mode == "close" else (rows[-2][0] if len(rows) > 1 else last)
            if len(rows) <= RECENT:
                dump(os.path.join(ROOT, "ohlc", f"{symbol}.json"), pack(symbol, rows, dividends, source, through))
                continue
            recent, old = rows[-RECENT:], rows[:-RECENT]
            hist_path = os.path.join(ROOT, "ohlc", "history", f"{symbol}.json")
            if not os.path.exists(hist_path):
                dump(hist_path, pack(symbol, old, [d for d in dividends if d[0] <= old[-1][0]], source, old[-1][0]))
            dump(os.path.join(ROOT, "ohlc", f"{symbol}.json"),
                 pack(symbol, recent, [d for d in dividends if d[0] > old[-1][0]], source, through, history_through=old[-1][0]))
    print(f"تم: {len(symbols) - len(missing)}/{len(symbols)} · الجلسة الأخيرة {data['asOf']}")
    if missing:
        print("بلا شموع:", missing)


if __name__ == "__main__":
    main()
