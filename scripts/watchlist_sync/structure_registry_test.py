"""A192 V3 / Codex D1 coverage gate: registry IDs == templates.ts ALL_TEMPLATES == builder switch cases; every board id
(structures.CATALOG + engine.structure_strategy) resolves through board_aliases; no dangling refs. Adding a template without
declaring its role / risk / valuation fails here."""
import re
import unittest
from pathlib import Path

import strategy_engine as SE
import structures as S

TS = Path(__file__).resolve().parents[2] / "artifacts/api-server/src/lib/structures/templates.ts"
REG = SE.RULES["structure_roles"]["templates"]
ALIAS = SE.RULES["board_aliases"]
KEYS = {"allowed_roles", "default_role", "technical_uses", "required_inputs", "optional_inputs", "valuation_capability",
        "max_loss", "recommendation_mode", "board_id"}


def ts_sets():
    t = TS.read_text()
    m = re.search(r"export const ALL_TEMPLATES: TemplateId\[\] = \[(.*?)\];", t, re.S)
    all_t = set(re.findall(r'"([a-z_]+)"', m.group(1)))
    ty = re.search(r"export type TemplateId =(.*?);", t, re.S)
    types = set(re.findall(r'"([a-z_]+)"', ty.group(1)))
    sw = t[t.index("switch (id)"):]
    cases = set(re.findall(r'case "([a-z_]+)":', sw[: sw.index("\n}\n")]))
    return all_t, types, cases


class Coverage(unittest.TestCase):
    def test_registry_equals_ts(self):
        all_t, types, cases = ts_sets()
        self.assertEqual(len(all_t), 39)
        self.assertEqual(set(REG), all_t); self.assertEqual(types, all_t); self.assertEqual(cases, all_t)

    def test_every_board_id_resolves(self):
        board = set(S.CATALOG) | set(SE.ENGINE["structure_strategy"])
        self.assertEqual(len(board), 17)
        self.assertEqual(set(ALIAS), board)
        for b, cid in ALIAS.items():
            self.assertIn(cid, REG, b); self.assertEqual(REG[cid]["board_id"], b)

    def test_entries_complete_no_dangling(self):
        for cid, e in REG.items():
            self.assertTrue(KEYS <= set(e), cid)
            self.assertIn(e["default_role"], e["allowed_roles"], cid)
            self.assertIn(e["valuation_capability"], ("horizon_mark", "payoff_only"), cid)
            for u in e["technical_uses"]:
                stg = u["policy"].removeprefix("legacy:")
                self.assertIn(stg, SE.ENGINE["strategies"], cid)

    def test_uncovered_call_tail_unlimited(self):
        for cid in ("short_naked_call", "short_strangle", "short_straddle", "call_front_ratio", "short_stock"):
            self.assertEqual(REG[cid]["max_loss"], "unlimited", cid)


if __name__ == "__main__":
    unittest.main()
