#!/usr/bin/env python3
"""Fixture: sample tercile picks match a357_regrade._tercile_book indices."""
from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from a357_sample import MIN_GROUP, pick_tercile_tags  # noqa: E402
from a357_regrade import _tagged_tercile_book, _tercile_book  # noqa: E402


def _fixture_day(d: date, n: int) -> list[dict]:
    rows = []
    for i in range(n):
        score = float((i * 17 + 3) % 100)
        rows.append(
            {
                "t": f"U{i:02d}",
                "d": d,
                "expiry": date(2025, 12, 19),
                "score": score,
                "pnl_traded": {0.0: score * 1e-4},
                "pnl_model": {0.0: score * 1e-4},
            }
        )
    return rows


class TestSampleTercile(unittest.TestCase):
    def test_picks_match_tercile_book(self) -> None:
        d = date(2025, 11, 3)
        g = _fixture_day(d, 30)
        self.assertGreaterEqual(len(g), MIN_GROUP)
        tags = pick_tercile_tags(g, d)
        ranked = sorted(g, key=lambda x: (-x["score"], x["t"]))
        n = max(1, len(g) // 3)
        champ_keys = {(e["t"], e["d"], e["expiry"]) for e in ranked[:n]}
        rng = np.random.default_rng(int(d.strftime("%Y%m%d")))
        pick = rng.choice(len(g), size=n, replace=False)
        rand_keys = {(g[i]["t"], g[i]["d"], g[i]["expiry"]) for i in pick}
        for key in champ_keys:
            self.assertIn(key, tags)
            self.assertIn(tags[key], ("champion", "both"))
        for key in rand_keys:
            self.assertIn(key, tags)
            self.assertIn(tags[key], ("random", "both"))

        tagged = []
        for e in g:
            key = (e["t"], e["d"], e["expiry"])
            if key in tags:
                tagged.append({**e, "book": tags[key]})

        ct_book, rt_book = _tercile_book({d: g}, "pnl_traded", 0.0)
        ct_tag, rt_tag, _ = _tagged_tercile_book({d: tagged}, "pnl_traded", 0.0)
        self.assertAlmostEqual(ct_tag[0], ct_book[0])
        self.assertAlmostEqual(rt_tag[0], rt_book[0])


if __name__ == "__main__":
    unittest.main()
