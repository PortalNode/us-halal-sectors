"""اختبارات شمعة الجلسة من TradingView في scripts/build_ohlc.py.

    python3 -m unittest discover -s tests -p 'test_*.py'
"""
import os
import sys
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import build_ohlc as b  # noqa: E402

NY = ZoneInfo("America/New_York")


def epoch(date):
    """ختم TradingView لشمعة يومية: 9:30 صباحًا بتوقيت نيويورك."""
    return int(datetime.strptime(f"{date} 09:30", "%Y-%m-%d %H:%M").replace(tzinfo=NY).timestamp())


# NVDA كما خزّنها ناسداك، ثم كما يعرضها TradingView (23 و24 و25 نوفمبر 2026)
STORED = [("2026-11-20", 143.52, 143.725, 124.5, 125.53, 500000000),
          ("2026-11-23", 167.035, 171.5, 156.93, 165.05, 600000000),
          ("2026-11-24", 159.1, 159.92, 150.5, 155.38, 400000000)]
TV_ROW = ["NVDA", epoch("2026-11-25"), 144.06, 150.37, 141.17, 149.3, 366567648,
          epoch("2026-11-24"), 159.1, 159.92, 150.5, 155.38, 381407884, "USD"]


class TvRow(unittest.TestCase):
    def test_reads_today_and_previous_session_in_new_york_time(self):
        s = b.tv_row(TV_ROW)
        self.assertEqual(s["today"], ("2026-11-25", 144.06, 150.37, 141.17, 149.3, 366567648))
        self.assertEqual(s["prev"][0], "2026-11-24")

    def test_rejects_other_currency_and_broken_bars(self):
        self.assertIsNone(b.tv_row(TV_ROW[:-1] + ["EUR"]))
        broken = list(TV_ROW)
        broken[3] = 140  # قمة دون الافتتاح
        self.assertIsNone(b.tv_row(broken)["today"])
        no_volume = list(TV_ROW)
        no_volume[6] = 0
        self.assertIsNone(b.tv_row(no_volume)["today"])


class AddSession(unittest.TestCase):
    session = b.tv_row(TV_ROW)

    def test_session_candle_comes_from_tradingview(self):
        rows, status = b.add_session(STORED, self.session, "2026-11-25")
        self.assertEqual(status, "added")
        self.assertEqual(rows[-1], ("2026-11-25", 144.06, 150.37, 141.17, 149.3, 366567648))
        # والجلسة السابقة تُستبدل بشمعة TradingView المكتملة (الحجم النهائي)
        self.assertEqual(rows[-2][5], 381407884)
        self.assertEqual(len(rows), 4)

    def test_rerun_replaces_the_same_session(self):
        once, _ = b.add_session(STORED, self.session, "2026-11-25")
        twice, _ = b.add_session(once, self.session, "2026-11-25")
        self.assertEqual(once, twice)

    def test_wrong_session_date_or_older_bar_is_ignored(self):
        self.assertEqual(b.add_session(STORED, self.session, "2026-11-26"), (STORED, None))
        later = STORED + [("2026-11-26", 150, 151, 149, 150, 1)]
        self.assertEqual(b.add_session(later, self.session, "2026-11-25")[1], None)
        self.assertEqual(b.add_session(STORED, None, "2026-11-25"), (STORED, None))

    def test_split_moves_the_whole_previous_bar(self):
        split = [r if r[0] != "2026-11-24" else (r[0], r[1] * 4, r[2] * 4, r[3] * 4, r[4] * 4, r[5] // 4) for r in STORED]
        self.assertEqual(b.add_session(split, self.session, "2026-11-25")[1], "split")

    def test_close_correction_alone_is_not_a_split(self):
        wrong = [r if r[0] != "2026-11-24" else (r[0], r[1], r[2] * 1.05, r[3], r[4] * 1.05, r[5]) for r in STORED]
        rows, status = b.add_session(wrong, self.session, "2026-11-25")
        self.assertEqual(status, "added")
        self.assertEqual(rows[-2][4], 155.38)

    def test_missed_sessions_ask_for_nasdaq_fill(self):
        # 21 نوفمبر (جمعة) و24 نوفمبر غير مخزنين
        short = STORED[:1]
        self.assertEqual(b.add_session(short, self.session, "2026-11-25")[1], "gap")
        rows, status = b.add_session(short, self.session, "2026-11-25", filled=True)
        self.assertEqual(status, "added")
        self.assertEqual([r[0] for r in rows], ["2026-11-20", "2026-11-24", "2026-11-25"])

    def test_weekend_is_not_a_gap(self):
        self.assertEqual(b.weekdays_between("2026-11-20", "2026-11-23"), 0)
        self.assertEqual(b.weekdays_between("2026-11-20", "2026-11-24"), 1)


class Settled(unittest.TestCase):
    def test_waits_for_tradingview_delay_after_the_close(self):
        at = lambda hm: datetime.strptime(f"2026-11-25 {hm}", "%Y-%m-%d %H:%M").replace(tzinfo=NY)
        self.assertFalse(b.session_settled(at("16:10"), "2026-11-25"))
        self.assertTrue(b.session_settled(at("16:20"), "2026-11-25"))
        self.assertTrue(b.session_settled(at("08:00"), "2026-11-24"))


if __name__ == "__main__":
    unittest.main()
