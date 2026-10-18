"""A151 — oj eval/verify guards for small or empty sets (no model calls)."""
from __future__ import annotations

import random
import unittest

import oj_evals


class ScoreEmpty(unittest.TestCase):
    def test_gate_keep_empty_pos(self):
        entry = {"rule": {"kind": "gate_keep", "threshold": 0.5, "target": 0.8}}
        items = [{"id": "a", "label": False}]
        ans = [{"id": "a", "answer": {"noul": 0.1}}]
        m = oj_evals.score("Ptest", items, ans, entry)
        self.assertIsNone(m["value"])
        self.assertEqual(m["n"], 1)

    def test_accuracy_empty_rows(self):
        entry = {"rule": {"kind": "accuracy", "target": 0.8}}
        m = oj_evals.score("Ptest", [], [], entry)
        self.assertIsNone(m["value"])
        self.assertEqual(m["n"], 0)

    def test_topk_empty_by_q(self):
        entry = {"rule": {"kind": "topk", "k": 3, "target": 0.8}}
        m = oj_evals.score("Ptest", [], [], entry)
        self.assertIsNone(m["value"])
        self.assertEqual(m["n"], 0)


class VerifySample(unittest.TestCase):
    def test_sample_k_floor_capped_at_len(self):
        """Mirror A151 formula: k = min(len, max(5, int(len * frac)))."""
        live_frac = 0.2
        for n in (0, 3, 10, 40):
            k = min(n, max(5, int(n * live_frac)))
            if n == 0:
                self.assertEqual(k, 0)
            elif n == 3:
                self.assertEqual(k, 3)  # min(3, 5)
            elif n == 10:
                self.assertEqual(k, 5)  # floor 5
            else:
                self.assertEqual(k, 8)  # int(40*0.2)=8
            if k:
                pop = list(range(n))
                sample = random.Random(0).sample(pop, k)
                self.assertEqual(len(sample), k)


if __name__ == "__main__":
    unittest.main()
