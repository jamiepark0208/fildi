"""A167 — promote options-1.1.0 (put-tuned tech score + nodeGap) to options champion, or roll back.

  .venv/bin/python promote_options_1_1_0.py            # promote (retires options-1.0.0)
  .venv/bin/python promote_options_1_1_0.py --rollback # options-1.0.0 champion again

Takes effect on the next option-score snapshot / Friday model_recs run (champion read per run).
"""
import json
import sys

from build_plan import connect

PUT_TECH = {"oversoldDepth": 0, "reversalSignal": 0, "volatilityState": 0, "trendContext": 0.5,
            "optionsFlow": 0, "relativePressure": 0, "analystUpside": 0, "volumeConfirm": -0.5}
RATIONALE = {
    "why": "S045: on weekly 1σ-IV puts (79k, 2020→2026, IV-controlled, OOS 2023→2026) trend − volumeConfirm sorts put pnl "
           "+15.7 bp/wk top−bottom quintile, −1.7 pp breach (t 4.5); current tech weights +4.0 (n.s.). Swing-low support adds 0 "
           "at fixed IV distance (t −0.4); a volume node between strike and spot is worse (t −3.9 beyond put tech) → support weight → nodeGap.",
    "scope": "put lane of the option score (Rankings + Friday model_recs → Model List). Display tech score and calls unchanged. "
             "Put tech levels quantile-matched to the default distribution (keeps the SQ floor's meaning).",
    "rollback": "promote_options_1_1_0.py --rollback",
}
EVIDENCE = {"study": "S045", "ask": "A167", "before_after": {
    "as_of": "2026-10-17", "n": 105, "rank_corr": 0.901, "top10": "8/10", "top20": "17/20", "top40": "36/40",
    "sq_gate_before": 2, "sq_gate_after": 11, "node_between": 43}}


def main() -> None:
    conn = connect()
    cur = conn.cursor()
    if "--rollback" in sys.argv:
        cur.execute("UPDATE scorecard_params SET status='retired' WHERE version='options-1.1.0'")
        cur.execute("UPDATE scorecard_params SET status='champion', promoted_at=now() WHERE version='options-1.0.0'")
    else:
        cur.execute("SELECT params FROM scorecard_params WHERE version='options-1.0.0'")
        params = dict(cur.fetchone()[0])
        sw = dict(params["strikeWeights"])
        sw["support"], sw["nodeGap"] = 0.0, 0.06
        params["strikeWeights"], params["putTechWeights"] = sw, PUT_TECH
        cur.execute("UPDATE scorecard_params SET status='retired' WHERE lane='options' AND status='champion'")
        cur.execute(
            """INSERT INTO scorecard_params (version, lane, status, parent, params, rationale, evidence, created_at, promoted_at, approved_by)
               VALUES ('options-1.1.0', 'options', 'champion', 'options-1.0.0', %s::jsonb, %s::jsonb, %s::jsonb, now(), now(), 'Jamie 10-18')
               ON CONFLICT (version) DO UPDATE SET status='champion', promoted_at=now()""",
            (json.dumps(params), json.dumps(RATIONALE), json.dumps(EVIDENCE)),
        )
    conn.commit()
    cur.execute("SELECT version, status FROM scorecard_params WHERE lane='options' ORDER BY version")
    print(cur.fetchall())


if __name__ == "__main__":
    main()
