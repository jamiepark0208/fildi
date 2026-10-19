"""A170 — promote options-1.2.0 = options-1.1.0 + call-lane tech weights (S046), or roll back to 1.1.0.

  .venv/bin/python promote_options_1_2_0.py            # promote
  .venv/bin/python promote_options_1_2_0.py --rollback # options-1.1.0 champion again
"""
import json
import sys

from build_plan import connect

CALL_TECH = {"oversoldDepth": 0, "reversalSignal": 0, "volatilityState": 0, "trendContext": 0, "optionsFlow": 0,
             "relativePressure": 0, "analystUpside": 0, "volumeConfirm": -0.5, "ma200Stretch": -0.5}
RATIONALE = {
    "why": "S046: on weekly 1σ-IV covered calls (78k, 2020→2026, IV-controlled) the current call tech total is slightly wrong-way "
           "(OOS −18.5 bp/wk top−bottom, n.s.); low volume + not stretched above the 200-day (engine inputs volumeRatioPct, "
           "priceVsMa200Atr) sorts overwrite pnl +42.9 bp/wk OOS (t 4.6, both halves). 'Don't cap a running, heavily traded stock.'",
    "scope": "call lane tech score → stockQuality (weight 0.12 × 0.6) and the stockQuality floor gate. Put lane = options-1.1.0. "
             "Display tech score unchanged.",
    "rollback": "promote_options_1_2_0.py --rollback",
}
EVIDENCE = {"study": "S046", "ask": "A170", "before_after_calls": {
    "as_of": "2026-10-17", "n": 143, "rank_corr": 0.993, "top10": "9/10", "top20": "18/20", "top40": "37/40",
    "sq_gate_before": 31, "sq_gate_after": 37}}


def main() -> None:
    conn = connect()
    cur = conn.cursor()
    if "--rollback" in sys.argv:
        cur.execute("UPDATE scorecard_params SET status='retired' WHERE version='options-1.2.0'")
        cur.execute("UPDATE scorecard_params SET status='champion', promoted_at=now() WHERE version='options-1.1.0'")
    else:
        cur.execute("SELECT params FROM scorecard_params WHERE version='options-1.1.0'")
        params = dict(cur.fetchone()[0])
        params["callTechWeights"] = CALL_TECH
        cur.execute("UPDATE scorecard_params SET status='retired' WHERE lane='options' AND status='champion'")
        cur.execute(
            """INSERT INTO scorecard_params (version, lane, status, parent, params, rationale, evidence, created_at, promoted_at, approved_by)
               VALUES ('options-1.2.0', 'options', 'champion', 'options-1.1.0', %s::jsonb, %s::jsonb, %s::jsonb, now(), now(), 'Jamie 10-18')
               ON CONFLICT (version) DO UPDATE SET status='champion', promoted_at=now()""",
            (json.dumps(params), json.dumps(RATIONALE), json.dumps(EVIDENCE)),
        )
    conn.commit()
    cur.execute("SELECT version, status FROM scorecard_params WHERE lane='options' ORDER BY version")
    print(cur.fetchall())


if __name__ == "__main__":
    main()
