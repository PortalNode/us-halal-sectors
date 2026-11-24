#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""توليد data.json وملفات الموقع من مصدرين:

1) قائمة الأسهم الشرعية: حيازات صندوق SPUS (SP Funds S&P 500 Sharia Industry Exclusions ETF)
   المتتبع لمؤشر S&P 500 Shariah. الملف CSV منشور يوميًا على موقع SP Funds.
2) الأسعار والمؤشرات المالية: TradingView Scanner (America).

الاستخدام:
    python3 scripts/build_data.py            # يحدّث data.json (+ الشعارات إن لم تكن موجودة)
    python3 scripts/build_data.py --logos    # يعيد تنزيل كل الشعارات
بايثون 3.9+ بدون أي مكتبات خارجية.
"""
import csv
import io
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time as dtime, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from arabic_names import NAMES_AR, SECTORS_AR  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
SPUS_CSV = "https://www.sp-funds.com/wp-content/uploads/data/TidalFG_Holdings_SPUS.csv"
SCANNER = "https://scanner.tradingview.com/america/scan"
NY = ZoneInfo("America/New_York")
INDEX_SYMBOL = "SPX"            # المؤشر المرجعي: S&P 500 (رمز الموقع؛ شموعه في ohlc/SPX.json من Cboe)
INDEX_TV = "SP:SPX"             # رمزه في TradingView
INDEX_LOGO = "indices/s-and-p-500"
FIRST_QUARTER_YEAR = 2022       # النتائج الربعية من أول ربع في هذه السنة المالية إلى آخر ربع معلن
SKIP_TICKERS = {"Cash&Other"}

COLS = [
    "name", "description", "logoid", "exchange", "sector", "industry", "currency", "type",
    "close", "change", "change_abs", "volume", "Value.Traded", "market_cap_basic",
    "earnings_per_share_diluted_ttm", "earnings_per_share_basic_ttm",
    "book_value_per_share_fq", "dividends_yield_current",
    "price_52_week_high", "price_52_week_low",
    "Perf.YTD", "Perf.3M", "Perf.6M", "Perf.Y",
    "total_shares_outstanding_fundamental", "time", "update_mode", "open", "high", "low",
    # بيانات صفحة النتائج
    "fiscal_period_current", "total_revenue_ttm", "net_income_ttm", "gross_margin_ttm", "operating_margin_ttm",
    "net_margin_ttm", "return_on_equity_fq", "debt_to_equity_fq", "total_assets_fq", "total_equity_fq",
    "shrhldrs_equity_fq",  # حقوق المساهمين العاديين (بلا حقوق الأقلية): بديل القيمة الدفترية للسهم إن غابت
    "free_cash_flow_ttm", "beta_5_year", "number_of_employees_fy",
    "total_revenue_fy_h", "net_income_fy_h", "earnings_per_share_diluted_fy_h",
    "total_assets_fy_h", "free_cash_flow_fy_h", "ebitda_fy_h", "fiscal_period_fy_h",
    "gross_profit_fy_h", "total_debt_fy_h", "earnings_per_share_basic_fy_h",
    "dps_common_stock_prim_issue_fy_h", "capital_expenditures_unchanged_fy_h",
    # النتائج الربعية (الأحدث أولًا)
    "fiscal_period_end_fq", "total_revenue_fq_h", "gross_profit_fq_h", "ebitda_fq_h", "net_income_fq_h",
    "earnings_per_share_diluted_fq_h", "free_cash_flow_fq_h", "total_assets_fq_h", "total_debt_fq_h",
    "capital_expenditures_unchanged_fq_h",
]


def http(url, data=None, headers=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def scan(body):
    raw = http(SCANNER, json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.loads(raw)


def num(value, digits=None):
    if value is None or isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return round(value, digits) if digits is not None else value


def market_is_open(now):
    now = now.astimezone(NY)
    return now.weekday() < 5 and dtime(9, 30) <= now.time() < dtime(16, 5)


def et_date(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).astimezone(NY).strftime("%Y-%m-%d")


def load_shariah_list():
    text = http(SPUS_CSV).decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text)))
    holdings, date = {}, None
    for row in rows:
        ticker = (row.get("StockTicker") or "").strip()
        date = date or row.get("Date")
        # رموز ليست أسهمًا قابلة للتداول (نقد، حقوق مشروطة، رموز مؤقتة)
        if not ticker or ticker in SKIP_TICKERS or not ticker.replace(".", "").replace("-", "").isalpha():
            continue
        try:
            weight = float((row.get("Weightings") or "0").strip().rstrip("%"))
        except ValueError:
            weight = None
        holdings[ticker] = {"weight": weight, "securityName": row.get("SecurityName")}
    iso = datetime.strptime(date, "%m/%d/%Y").strftime("%Y-%m-%d") if date else None
    return holdings, iso


def fetch_logo(args):
    symbol, logoid, force = args
    path = os.path.join(ROOT, "logos", f"{symbol}.svg")
    if os.path.exists(path) and not force:
        return symbol, True
    if not logoid:
        return symbol, False
    try:
        svg = http(f"https://s3-symbol-logo.tradingview.com/{logoid}.svg", timeout=30)
        if b"<svg" not in svg[:500]:
            return symbol, False
        with open(path, "wb") as handle:
            handle.write(svg)
        return symbol, True
    except Exception:
        return symbol, False


def quarter_labels(current, count):
    """«2026-Q4» → [«2026-Q4», «2026-Q3», …] بالترتيب العكسي (الأحدث أولًا)."""
    try:
        year, quarter = current.split("-Q")
        year, quarter = int(year), int(quarter)
    except Exception:
        return []
    labels = []
    for _ in range(count):
        labels.append(f"{year}-Q{quarter}")
        quarter -= 1
        if quarter == 0:
            quarter, year = 4, year - 1
    return labels


def fiscal_year_end_month(label, end_epoch):
    """شهر نهاية السنة المالية من تسمية آخر ربع معلن وتاريخ نهايته: «2027-Q1» تنتهي في سبتمبر ⇒ السنة تنتهي في يونيو."""
    try:
        quarter = int(label.split("-Q")[1])
        month = datetime.fromtimestamp(end_epoch, timezone.utc).month
    except Exception:
        return None
    return (month - 1 + (4 - quarter) * 3) % 12 + 1


def quarterly_block(row):
    """كل الأرباع المتاحة من أول FIRST_QUARTER_YEAR؛ الربع الأحدث هو fiscal_period_current، والأقدم بالتسلسل (الأحدث أولًا)."""
    fields = {"revenue": "total_revenue_fq_h", "grossProfit": "gross_profit_fq_h", "ebitda": "ebitda_fq_h",
              "netIncome": "net_income_fq_h", "eps": "earnings_per_share_diluted_fq_h",
              "freeCashFlow": "free_cash_flow_fq_h", "assets": "total_assets_fq_h", "debt": "total_debt_fq_h",
              "capex": "capital_expenditures_unchanged_fq_h"}
    series = {key: (row.get(field) or []) for key, field in fields.items()}
    count = max((len(v) for v in series.values()), default=0)
    end = row.get("fiscal_period_end_fq")
    labels = quarter_labels(row.get("fiscal_period_current") or "", count)
    keep = sum(1 for label in labels if int(label[:4]) >= FIRST_QUARTER_YEAR)
    return {"labels": labels[:keep], "latestEnd": end,
            "fiscalYearEnd": fiscal_year_end_month(row.get("fiscal_period_current") or "", end) if end else None,
            **{key: v[:keep] for key, v in series.items()}}


def main():
    force_logos = "--logos" in sys.argv
    now = datetime.now(timezone.utc)
    holdings, holdings_date = load_shariah_list()
    tickers = sorted(holdings)
    print(f"قائمة SPUS: {len(tickers)} رمزًا · {holdings_date}")

    result = scan({
        "filter": [{"left": "name", "operation": "in_range", "right": tickers},
                   {"left": "type", "operation": "equal", "right": "stock"}],
        "columns": COLS, "range": [0, 700], "options": {"lang": "en"},
    })
    index_result = scan({"symbols": {"tickers": [INDEX_TV]}, "columns": COLS})
    rows = {}
    for item in result["data"]:
        record = dict(zip(COLS, item["d"]))
        record["tv"] = item["s"]
        # عند تكرار الرمز في أكثر من سوق نفضّل NYSE/NASDAQ
        if record["name"] not in rows or record["exchange"] in ("NYSE", "NASDAQ"):
            rows[record["name"]] = record
    missing = [t for t in tickers if t not in rows]
    if missing:
        print("غير متاحة في TradingView:", missing)

    index_row = dict(zip(COLS, index_result["data"][0]["d"]))
    session_epoch = max((r["time"] for r in rows.values() if r.get("time")), default=None)
    price_date = et_date(session_epoch) if session_epoch else now.astimezone(NY).strftime("%Y-%m-%d")
    open_now = market_is_open(now)
    mode = "delayed" if open_now else "close"
    checked_at = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    sectors, financials, logo_jobs = {}, {}, []
    for ticker in tickers:
        row = rows.get(ticker)
        if not row or not row.get("close"):
            continue
        industry = row.get("industry") or ""
        sector_key = "REIT" if "Real Estate Investment Trusts" in industry else row.get("sector") or "Miscellaneous"
        price = num(row["close"])
        shares = num(row.get("total_shares_outstanding_fundamental"))
        market_cap = num(row.get("market_cap_basic"))
        diluted = num(row.get("earnings_per_share_diluted_ttm"), 4)
        basic = num(row.get("earnings_per_share_basic_ttm"), 4)
        book = num(row.get("book_value_per_share_fq"), 4)
        book_source = "TradingView book_value_per_share_fq"
        if book is None:
            # تريدينغ فيو يُسقط القيمة الدفترية للسهم أحيانًا لبعض الشركات؛ نحسبها من حقوق المساهمين العاديين
            # لآخر ربع ÷ عدد الأسهم القائمة (المعادلة نفسها التي يستخدمها تريدينغ فيو).
            equity = num(row.get("shrhldrs_equity_fq"))
            book = round(equity / shares, 4) if equity is not None and shares else None
            book_source = "shrhldrs_equity_fq / total_shares_outstanding_fundamental" if book is not None else None
        stock = {
            "symbol": ticker,
            "name": NAMES_AR.get(ticker) or row["description"],
            "nameEn": row["description"],
            "tvSymbol": row["tv"],
            "exchange": row["exchange"],
            "industry": industry,
            "price": price,
            "eps": diluted,
            "epsDiluted": diluted,
            "epsBasic": basic,
            "pe": round(price / diluted, 4) if diluted and diluted > 0 and price else None,
            "bookValue": book,
            "bookValueSource": book_source if book is not None else None,
            "pb": round(price / book, 4) if book and book > 0 and price else None,
            "marketCap": round(market_cap / 1e9, 4) if market_cap else None,  # مليار دولار
            "day": num(row.get("change"), 4),
            "ytd": num(row.get("Perf.YTD"), 4),
            "month3": num(row.get("Perf.3M"), 4),
            "month6": num(row.get("Perf.6M"), 4),
            "year1": num(row.get("Perf.Y"), 4),
            "shares": int(shares) if shares else None,
            "dividendYield": num(row.get("dividends_yield_current"), 4),
            "dividendYieldSource": "TradingView Dividend Yield (TTM)",
            "week52Low": num(row.get("price_52_week_low"), 4),
            "week52High": num(row.get("price_52_week_high"), 4),
            "week52Source": "TradingView",
            "week52CheckedAt": checked_at,
            "priceDate": price_date,
            "priceTimestamp": None,
            "priceSource": "TradingView",
            "priceStatus": "delayed" if open_now else "close",
            "marketCapSource": "TradingView",
            "suspended": False,
            "priceCheckedAt": checked_at,
            "performanceDate": price_date,
            "performanceSource": "TradingView",
            "tradedValue": num(row.get("Value.Traded"), 2),  # دولار
            "tradedValueSource": "TradingView",
            "volume": int(row["volume"]) if row.get("volume") is not None else None,
            "shariahWeight": holdings[ticker]["weight"],
        }
        sectors.setdefault(sector_key, []).append(stock)
        financials[ticker] = {
            "fiscalPeriod": row.get("fiscal_period_current"),
            "ttm": {
                "revenue": num(row.get("total_revenue_ttm")), "netIncome": num(row.get("net_income_ttm")),
                "grossMargin": num(row.get("gross_margin_ttm"), 4), "operatingMargin": num(row.get("operating_margin_ttm"), 4),
                "netMargin": num(row.get("net_margin_ttm"), 4), "freeCashFlow": num(row.get("free_cash_flow_ttm")),
            },
            "roe": num(row.get("return_on_equity_fq"), 4), "debtToEquity": num(row.get("debt_to_equity_fq"), 4),
            "totalAssets": num(row.get("total_assets_fq")), "totalEquity": num(row.get("total_equity_fq")),
            "beta": num(row.get("beta_5_year"), 4), "employees": num(row.get("number_of_employees_fy")),
            "annual": {  # الأحدث أولًا، حتى 6 سنوات مالية
                "years": (row.get("fiscal_period_fy_h") or [])[:6],
                **{key: (row.get(field) or [])[:6] for key, field in (
                    ("revenue", "total_revenue_fy_h"), ("grossProfit", "gross_profit_fy_h"), ("ebitda", "ebitda_fy_h"),
                    ("netIncome", "net_income_fy_h"), ("eps", "earnings_per_share_diluted_fy_h"),
                    ("epsBasic", "earnings_per_share_basic_fy_h"), ("dps", "dps_common_stock_prim_issue_fy_h"),
                    ("assets", "total_assets_fy_h"), ("debt", "total_debt_fy_h"),
                    ("freeCashFlow", "free_cash_flow_fy_h"), ("capex", "capital_expenditures_unchanged_fy_h"))},
            },
        }
        financials[ticker]["quarterly"] = quarterly_block(row)
        logo_jobs.append((ticker, row.get("logoid"), force_logos))

    logo_jobs.append((INDEX_SYMBOL, index_row.get("logoid") or INDEX_LOGO, force_logos))
    os.makedirs(os.path.join(ROOT, "logos"), exist_ok=True)
    with ThreadPoolExecutor(8) as pool:
        logos = dict(pool.map(fetch_logo, logo_jobs))
    with open(os.path.join(ROOT, "logos", "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump({"source": "TradingView", "symbols": sorted(s for s, ok in logos.items() if ok)}, handle, ensure_ascii=False)

    sector_list = [
        {"key": key, "name": SECTORS_AR.get(key, key),
         "stocks": sorted(stocks, key=lambda s: -(s["marketCap"] or 0))}
        for key, stocks in sectors.items()
    ]
    sector_list.sort(key=lambda s: -sum(x["marketCap"] or 0 for x in s["stocks"]))
    all_stocks = [s for sector in sector_list for s in sector["stocks"]]
    turnover = sum(s["tradedValue"] or 0 for s in all_stocks)

    price_et = datetime.strptime(price_date, "%Y-%m-%d").strftime("%d.%m.%Y")
    data = {
        "asOf": price_date,
        "financialPeriod": "آخر أربعة أرباع (TTM) بحسب TradingView؛ النتائج الربعية من 2022",
        "sources": {
            "shariahList": SPUS_CSV,
            "shariahListName": "SP Funds S&P 500 Sharia Industry Exclusions ETF (SPUS)",
            "fundamentals": "https://www.tradingview.com/markets/stocks-usa/market-movers-large-cap/",
            "marketCap": "https://www.tradingview.com/markets/stocks-usa/market-movers-large-cap/",
            "performance": "https://www.tradingview.com/markets/stocks-usa/market-movers-large-cap/",
            "closingPrices": "https://www.tradingview.com/markets/stocks-usa/",
            "delayedPrices": "https://www.tradingview.com/markets/stocks-usa/",
        },
        "shariah": {
            "source": "SPUS", "sourceName": "SP Funds S&P 500 Sharia Industry Exclusions ETF",
            "indexName": "S&P 500 Shariah Index", "holdingsDate": holdings_date,
            "holdingsCount": len(tickers), "listedCount": len(all_stocks), "url": "https://www.sp-funds.com/spus/",
        },
        "sectors": sector_list,
        "priceDate": price_et,
        "priceSource": {
            "provider": "TradingView", "mode": mode, "checkedAt": checked_at, "observedDate": price_date,
            "delayMinutes": 15 if open_now else None, "officialDate": price_date if not open_now else None,
            "officialSymbols": len(all_stocks) if not open_now else 0, "tradingViewSymbols": len(all_stocks),
            "unavailableSymbols": len(tickers) - len(all_stocks), "warning": None,
        },
        "marketSummary": {
            "value": num(index_row.get("close"), 4), "pointChange": num(index_row.get("change_abs"), 4),
            "day": num(index_row.get("change"), 4), "turnover": round(turnover, 2), "date": price_et,
            "source": "TradingView", "turnoverSource": "TradingView", "mode": mode, "isIntraday": open_now,
            "updatedAt": checked_at, "turnoverEstimated": False,
            "ytd": num(index_row.get("Perf.YTD"), 4), "month3": num(index_row.get("Perf.3M"), 4),
            "month6": num(index_row.get("Perf.6M"), 4), "year1": num(index_row.get("Perf.Y"), 4),
            "performanceDate": price_date, "performanceSource": "TradingView",
            "indexSymbol": INDEX_SYMBOL, "indexName": "مؤشر S&P 500", "indexTv": INDEX_TV,
            # شمعة المؤشر لآخر جلسة مكتملة (احتياط حين يتعذر مصدر شموعه Cboe)
            "ohlc": None if open_now else {"date": price_date, "open": num(index_row.get("open"), 4), "high": num(index_row.get("high"), 4),
                                           "low": num(index_row.get("low"), 4), "close": num(index_row.get("close"), 4)},
        },
    }
    with open(os.path.join(ROOT, "data.json"), "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(ROOT, "financials.json"), "w", encoding="utf-8") as handle:
        json.dump({"asOf": price_date, "source": "TradingView", "companies": financials}, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"data.json: {len(sector_list)} قطاعًا · {len(all_stocks)} شركة · الوضع {mode} · {price_date}")
    print(f"الشعارات: {sum(logos.values())}/{len(logos)}")


if __name__ == "__main__":
    main()
