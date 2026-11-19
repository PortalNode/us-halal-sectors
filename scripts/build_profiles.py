#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""نبذة عن كل شركة → company-profiles.json

- تاريخ التأسيس وتاريخ الإدراج في البورصة: Wikidata (خاصية inception P571، وبداية إدراج البورصة P414/P580).
- وصف النشاط: مقدمة صفحة ويكيبيديا العربية للشركة، وإن لم تكن لها صفحة فالإنجليزية.
يعمل مرة واحدة (أو عند ظهور شركات جديدة): لا يعيد جلب الشركات الموجودة في الملف إلا مع --all.

    python3 scripts/build_profiles.py        # الشركات الجديدة فقط
    python3 scripts/build_profiles.py --all  # إعادة كل شيء
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "us-halal-sectors-builder/1.0 (educational project; github.com/PortalNode/us-halal-sectors)"}
SPARQL = "https://query.wikidata.org/sparql"
NYSE, NASDAQ = "wd:Q13677", "wd:Q82059"


def http(url, data=None, headers=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def wikidata(tickers):
    values = " ".join(f'"{t}"' for t in tickers)
    query = f"""SELECT ?item ?ticker ?inc ?incp ?start ?startp ?ar ?en WHERE {{
      VALUES ?t {{ {values} }}
      ?item p:P414 ?st. ?st ps:P414 ?ex. ?st pq:P249 ?ticker. FILTER(?ticker = ?t) FILTER(?ex IN ({NYSE}, {NASDAQ}))
      OPTIONAL {{ ?st pqv:P580 ?sv. ?sv wikibase:timeValue ?start; wikibase:timePrecision ?startp. }}
      OPTIONAL {{ ?item p:P571 ?is. ?is psv:P571 ?iv. ?iv wikibase:timeValue ?inc; wikibase:timePrecision ?incp. }}
      OPTIONAL {{ ?ar schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>. }}
      OPTIONAL {{ ?en schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>. }}
    }}"""
    raw = http(SPARQL, urllib.parse.urlencode({"query": query, "format": "json"}).encode(),
               {"Accept": "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded"}, 120)
    out = {}
    for b in json.loads(raw)["results"]["bindings"]:
        g = lambda k: b[k]["value"] if k in b else None
        rec = out.setdefault(g("ticker"), {"inc": [], "start": [], "ar": g("ar"), "en": g("en")})
        if g("inc"):
            rec["inc"].append((g("inc")[:10], int(g("incp") or 11)))
        if g("start"):
            rec["start"].append((g("start")[:10], int(g("startp") or 11)))
        rec["ar"] = rec["ar"] or g("ar")
        rec["en"] = rec["en"] or g("en")
    return out


def precise(pairs):
    """أقدم تاريخ؛ الدقة: 9 سنة، 10 شهر، 11 يوم."""
    pairs = [p for p in pairs if re.match(r"^\d{4}-\d{2}-\d{2}$", p[0]) and not p[0].startswith("-")]
    if not pairs:
        return None, None
    date, prec = min(pairs)
    return date, {9: "year", 10: "month"}.get(prec, "day")


def summary(url):
    if not url:
        return None
    lang = url.split("//")[1].split(".")[0]
    title = url.rsplit("/wiki/", 1)[1]
    api = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}"
    for attempt in range(3):
        try:
            data = json.loads(http(api, headers={"Accept": "application/json"}, timeout=30))
            text = re.sub(r"\s+", " ", data.get("extract") or "").strip()
            return (text, lang) if text else None
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            time.sleep(3 * (attempt + 1))
        except Exception:
            time.sleep(3)
    return None


def shorten(text, limit=360):
    """جملتان أو ثلاث بحد أقصى ~360 حرفًا، بلا قطع في منتصف جملة."""
    parts = re.split(r"(?<=[.!؟?])\s+(?=[\"«]?[A-Zأ-ي0-9])", text)
    out = ""
    for part in parts:
        if out and len(out) + len(part) > limit:
            break
        out = f"{out} {part}".strip()
        if len(out) >= limit * 0.6:
            break
    return out[: limit + 120]


def main():
    with open(os.path.join(ROOT, "data.json"), encoding="utf-8") as handle:
        data = json.load(handle)
    stocks = {s["symbol"]: s for sector in data["sectors"] for s in sector["stocks"]}
    path = os.path.join(ROOT, "company-profiles.json")
    profiles = {}
    if os.path.exists(path) and "--all" not in sys.argv:
        with open(path, encoding="utf-8") as handle:
            profiles = json.load(handle)
    todo = [t for t in stocks if t not in profiles]
    print(f"مطلوب: {len(todo)} شركة")
    if not todo:
        return
    found = {}
    for i in range(0, len(todo), 60):
        found.update(wikidata(todo[i:i + 60]))
        time.sleep(1)
    for ticker in todo:
        rec = found.get(ticker, {})
        founded, founded_p = precise(rec.get("inc", []))
        listed, listed_p = precise(rec.get("start", []))
        text = summary(rec.get("ar")) or summary(rec.get("en"))
        profile = {"founded": founded, "foundedPrecision": founded_p, "listed": listed, "listedPrecision": listed_p,
                   "activity": shorten(text[0]) if text else None, "activityLang": text[1] if text else None,
                   "wiki": rec.get("ar") or rec.get("en"), "source": "Wikidata / Wikipedia"}
        profiles[ticker] = profile
        time.sleep(0.2)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(profiles, handle, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    have = lambda k: sum(1 for p in profiles.values() if p.get(k))
    print(f"تم: تأسيس {have('founded')} · إدراج {have('listed')} · نشاط {have('activity')} · عربي "
          f"{sum(1 for p in profiles.values() if p.get('activityLang') == 'ar')} من {len(profiles)}")


if __name__ == "__main__":
    main()
