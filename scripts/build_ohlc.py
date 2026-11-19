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


_yahoo_blocked_until = 0.0
NASDAQ = "https://api.nasdaq.com/api/quote/{sym}/historical?assetclass={cls}&fromdate={start}&limit=1600&todate={end}"
SPLITS = [1.5, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 40, 50]


def day(ts):
    return datetime.fromtimestamp(ts, timezone.utc).astimezone(NY).strftime("%Y-%m-%d")


def yahoo(symbol):
    """Yahoo: شموع معدّلة للتجزئة + التوزيعات. عند الحظر (429) نتوقف عنه 15 دقيقة حتى لا نطيل الحظر."""
    global _yahoo_blocked_until
    if time.time() < _yahoo_blocked_until:
        return None
    url = f"https://{HOSTS[0]}/v8/finance/chart/{symbol.replace('.', '-')}?range=5y&interval=1d&events=div"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            result = json.load(r)["chart"]["result"][0]
        time.sleep(1.0)
    except urllib.error.HTTPError as error:
        if error.code == 429:
            _yahoo_blocked_until = time.time() + 900
        return None
    except Exception:
        return None
    quote = result["indicators"]["quote"][0]
    rows = {}
    for i, ts in enumerate(result.get("timestamp") or []):
        o, h, l, c, v = (quote[k][i] for k in ("open", "high", "low", "close", "volume"))
        if None not in (o, h, l, c):
            rows[day(ts)] = (day(ts), round(o, 4), round(h, 4), round(l, 4), round(c, 4), int(v or 0))
    dividends = sorted([day(int(k)), round(v["amount"], 6)] for k, v in (result.get("events", {}).get("dividends") or {}).items())
    return [rows[d] for d in sorted(rows)], dividends, "Yahoo Finance"


def adjust_splits(rows):
    """Nasdaq يعطي أسعارًا خام: نكشف التجزئة (قفزة في السعر يقابلها قفزة معاكسة في الحجم) ونعدّل ما قبلها."""
    rows = [list(r) for r in rows]
    for i in range(len(rows) - 1, 0, -1):
        prev, cur = rows[i - 1], rows[i]
        if not cur[4] or not prev[4]:
            continue
        ratio = prev[4] / cur[4]  # >1: تجزئة عادية، <1: تجزئة عكسية
        n = ratio if ratio >= 1 else 1 / ratio
        near = min(SPLITS, key=lambda k: abs(k - n))
        if abs(n - near) / near > 0.12 or n < 1.4:
            continue
        vol = (cur[5] / prev[5]) if prev[5] else 0
        if (ratio >= 1 and vol > near * 0.5) or (ratio < 1 and 0 < vol < 2 / near):
            factor = near if ratio >= 1 else 1 / near
            for j in range(i):
                for k in (1, 2, 3, 4):
                    rows[j][k] = round(rows[j][k] / factor, 4)
                rows[j][5] = int(rows[j][5] * factor)
    return [tuple(r) for r in rows]


def nasdaq(symbol):
    end = datetime.now(NY)
    start = end.replace(year=end.year - 5)
    money = lambda x: float(x.replace("$", "").replace(",", ""))
    for cls in ("stocks", "etf"):
        url = NASDAQ.format(sym=symbol, cls=cls, start=start.strftime("%Y-%m-%d"), end=end.strftime("%Y-%m-%d"))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                table = (json.load(r).get("data") or {}).get("tradesTable") or {}
            time.sleep(0.4)
        except Exception:
            time.sleep(2)
            continue
        rows = []
        for x in table.get("rows") or []:
            try:
                m, d, y = x["date"].split("/")
                vol = x.get("volume") or ""
                vol = int(vol.replace(",", "")) if vol.replace(",", "").isdigit() else 0
                rows.append((f"{y}-{m}-{d}", money(x["open"]), money(x["high"]), money(x["low"]), money(x["close"]), vol))
            except (ValueError, KeyError):
                continue
        if rows:
            return adjust_splits(sorted(rows)), [], "Nasdaq (معدّل للتجزئة)"
    return None


def build(symbol):
    built = yahoo(symbol) or nasdaq(symbol)
    return symbol, built


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
    missing = []
    with ThreadPoolExecutor(1) as pool:
        for symbol, built in pool.map(build, symbols):
            if not built:
                missing.append(symbol)
                continue
            rows, dividends, how = built
            source = f"{how} · " + ("إغلاق الجلسة" if mode == "close" else "شموع متأخرة")
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
