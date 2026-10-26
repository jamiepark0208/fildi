"""Exercise actual pure report/replay functions without importing vendor/DB dependencies."""
import ast
import contextlib
import hashlib
import io
import json
from pathlib import Path
import random
import statistics
import sys
import tempfile
import unittest
from collections import defaultdict
from datetime import date, timedelta
from unittest.mock import Mock, patch

SOURCE = Path(__file__).with_name("s071_delta_real.py")


class ReplayTests(unittest.TestCase):
    def test_budget_stop_closes_connection_without_final_result(self):
        tree = ast.parse(SOURCE.read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "collect")
        conn, ld, op = Mock(), Mock(), Mock()
        ld.limit, ld.requests, ld.remaining = 2500, 2400, 100
        ns = dict(rng=random.Random(71), connect=lambda:conn, OP=op,
                  load=lambda *a:({"TEST":[]}, {}), REQ_CAP=2500,
                  lseg_session=lambda:contextlib.nullcontext(ld))
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE), "exec"), ns)
        with self.assertRaisesRegex(RuntimeError, "no final report"):
            ns["collect"](None)
        conn.close.assert_called_once()

    def test_replay_is_identical_and_never_collects(self):
        tree = ast.parse(SOURCE.read_text())
        ns = dict(globals(), __file__=str(SOURCE), rng=random.Random(71),
                  HOLDOUT=date(2024, 7, 1), OUT=Path("unused"),
                  BUCKETS=((.05, .125), (.125, .175), (.175, .225), (.225, .275), (.275, .35)))
        functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name != "collect"]
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), "exec"), ns)
        ns["collect"] = Mock(side_effect=AssertionError("Replay attempted acquisition"))
        rows = []
        for i in range(35):
            d = date(2025, 1, 6) + timedelta(weeks=i)
            for j, delta in enumerate((.1, .2)):
                rows.append(dict(t="TEST", d=d, e=d+timedelta(days=4), K=100, dl=delta,
                                 prem=.004+j*.004, iv=.25, mid=.005+j*.004, m252=.006, m365=.005,
                                 Se=101, pnl=.003+(i%5)*.001-j*.002, itm=False))
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            root = Path(tmp)
            ledger, expected, actual = root/"trades.json", root/"expected.md", root/"actual.md"
            ns["save_trades"](ledger, rows, ["TEST"])
            ns["report"](rows, ["TEST"], expected)
            ns["rng"].random()  # replay must not depend on previous random state
            with patch.object(sys, "argv", ["study", f"--from-trades={ledger}", f"--output={actual}"]):
                ns["main"]()
            self.assertEqual(expected.read_bytes(), actual.read_bytes())
            ns["collect"].assert_not_called()
            ledger.write_text('{"schema": 1, "study": "wrong"}')
            with self.assertRaises(ValueError):
                ns["read_trades"](ledger)


if __name__ == "__main__":
    unittest.main()
