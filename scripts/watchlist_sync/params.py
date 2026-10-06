"""Versioned model parameters: the single place the learning loop (learn.py) is allowed to change.

watchlist_sync.model_params holds one row per version:
  champion   the live parameter set (exactly one)
  challenger proposed by learn.py from evidence; scored in shadow beside the champion until promoted or retired
  retired    superseded; kept for audit / rollback
Every version records its parent, the rationale, and the evidence it was derived from. Promotion is approval-gated unless
AUTO_PROMOTE is enabled in the champion's own params (bounded changes only; see learn.py).
"""
from __future__ import annotations

import copy
import json

from build_plan import rows

DDL = """
CREATE TABLE IF NOT EXISTS watchlist_sync.model_params (
  version      text PRIMARY KEY,
  status       text NOT NULL,                 -- champion | challenger | retired
  parent       text,
  params       jsonb NOT NULL,
  rationale    jsonb,                         -- [{param, old, new, why}]
  evidence     jsonb,                         -- metrics the change was derived from
  created_at   timestamptz NOT NULL DEFAULT now(),
  promoted_at  timestamptz,
  approved_by  text                            -- 'user' | 'auto (bounded)'
);
CREATE UNIQUE INDEX IF NOT EXISTS model_params_one_champion ON watchlist_sync.model_params ((status)) WHERE status = 'champion';
"""

# fit-1.4.0 seed: fit-1.4 shadow design + the Step 4 proposals approved by the user on 2026-10-05.
SEED_VERSION = "fit-1.4.0"
SEED = {
    "premium": {"w_iv_rv": 0.70, "w_iv_rank": 0.30, "w_iv_level": 0.00},     # Step 4 #1 (raw IV level had no edge)
    "street": {"k": 8.0, "floor_credit": 20, "floor_own": 40, "timing_far": 0.75, "analyst_saturation": 8},
    "own": {"w_fund": 0.45, "w_credit": 0.35, "w_cam": 0.20},
    "thresholds": {"green_own": 62, "green_credit": 40, "yellow_premium": 55, "yellow_own": 45, "yellow_fit": 60, "red_risk": 1.0,
                   "put_block_risk": 0.3,
                   "min_weekly_realistic": 0.35},   # Step 8: scanner's 0.50%/wk is on Yahoo bids; RH realistic fills run 16–35% lower                                    # sell-puts cross-check: hold back at this risk
    "severity": {                                                             # Step 4 #6: falling knife 0.5 → 0.2
        "credit_distress": 1.0, "credit_fragile": 0.6, "arm_very": 0.6, "arm_hard": 0.4, "fund_very": 0.6, "fund_weak": 0.4,
        "falling_knife": 0.2, "short_heavy": 0.6, "short_high": 0.4, "miss_big": 0.6, "miss": 0.3, "pt_implausible": 0.2,
    },
    "regime": {"pause_puts_spy20": -0.05},
    "portfolio": {"budget_pct": 0.60, "use_margin": False, "max_position_pct": 0.35, "max_per_sector": 2, "sector_pct": 0.50,   # Step 7
                  "take_profit": 0.50, "at_risk_pct": 0.03, "expiry_days": 2, "allow_below_cost_if_red": True,
                  "min_yield_edge": 0.10},   # close an open put to fund a new one only if it earns ≥10% less per week on its collateral                                    # Step 4 #8: no dip-buying puts in broad selloffs
    "learning": {"auto_promote": False, "max_rel_step": 0.25, "min_months": 24, "min_t": 2.0, "min_live_grades": 30,
                 "auto_max_verdict_share": 0.10},
}


def ensure(conn) -> None:
    conn.execute(DDL)
    if not rows(conn, "SELECT 1 FROM watchlist_sync.model_params LIMIT 1"):
        conn.execute("""INSERT INTO watchlist_sync.model_params (version, status, params, rationale, promoted_at, approved_by)
                        VALUES (%s, 'champion', %s, %s, now(), 'user')""",
                     (SEED_VERSION, json.dumps(SEED), json.dumps([{"why": "seed: fit-1.4 shadow + Step 4 proposals approved by the user 2026-10-05"}])))
        conn.commit()


def champion(conn) -> tuple[str, dict]:
    ensure(conn)
    r = rows(conn, "SELECT version, params FROM watchlist_sync.model_params WHERE status = 'champion'")[0]
    return r["version"], merged(r["params"])


def challengers(conn) -> list[tuple[str, dict]]:
    ensure(conn)
    return [(r["version"], merged(r["params"])) for r in rows(conn, "SELECT version, params FROM watchlist_sync.model_params WHERE status = 'challenger' ORDER BY created_at")]


def merged(p: dict) -> dict:
    """Fill keys added to SEED after a version was saved, so old versions stay loadable."""
    out = copy.deepcopy(SEED)
    for k, v in (p or {}).items():
        if isinstance(v, dict):
            out.setdefault(k, {}).update(v)
        else:
            out[k] = v
    return out
