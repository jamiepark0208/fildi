"""A191 — register options-1.3.0 as options-lane challenger (shadow-first; champion stays).

  .venv/bin/python register_options_1_3_0.py            # upsert challenger
  .venv/bin/python register_options_1_3_0.py --retire   # status=retired

S059 put-edge factors: continuous IV/RV percentile + vol-of-vol percentile;
ivAbsolute weight → 0 (S014 wrong sign). Put-lane tech from champion (1.2.0).
"""
from __future__ import annotations

import json
import sys

from build_plan import connect

STRIKE = {
    "income": 0.28,
    "buffer": 0.28,
    "ivRelative": 0.12,
    "volOfVol": 0.10,
    "ivAbsolute": 0.0,
    "stockQuality": 0.12,
    "support": 0.0,
    "nodeGap": 0.06,
    "dte": 0.04,
}
RATIONALE = {
    "why": "S059: Model List put_edge (IV/RV + vol-of-vol + put tech) sorts short-put edge; "
           "scanner ivRelative was rank+IV>RV bonus and ivAbsolute had wrong sign (S014). "
           "Shadow-first as options-1.3.0 — champion picks unchanged until graded.",
    "scope": "put shadow scores on option_score_snapshots + model_recs (A172 path). "
             "Challenger status; does not retire options-1.2.0.",
    "ask": "A191",
    "rollback": "register_options_1_3_0.py --retire",
}
EVIDENCE = {"study": "S059", "ask": "A191", "calibration": "put_edge_calibration.json"}


def main() -> None:
    conn = connect()
    cur = conn.cursor()
    if "--retire" in sys.argv:
        cur.execute("UPDATE scorecard_params SET status='retired' WHERE version='options-1.3.0'")
        conn.commit()
        print("retired options-1.3.0")
        return

    cur.execute("SELECT params FROM scorecard_params WHERE version='options-1.2.0'")
    row = cur.fetchone()
    if not row:
        cur.execute("SELECT params FROM scorecard_params WHERE lane='options' AND status='champion'")
        row = cur.fetchone()
    if not row:
        raise SystemExit("no options champion/1.2.0 params to clone")
    params = dict(row[0])
    params["strikeWeights"] = STRIKE
    # Keep putTechWeights / callTechWeights from champion clone.
    cur.execute("UPDATE scorecard_params SET status='retired' WHERE lane='options' AND status='challenger' AND version <> 'options-1.3.0'")
    cur.execute(
        """INSERT INTO scorecard_params (version, lane, status, parent, params, rationale, evidence, created_at, approved_by)
           VALUES ('options-1.3.0', 'options', 'challenger', 'options-1.2.0', %s::jsonb, %s::jsonb, %s::jsonb, now(), 'Jamie via A191')
           ON CONFLICT (version) DO UPDATE SET status='challenger', params=excluded.params,
             rationale=excluded.rationale, evidence=excluded.evidence, parent=excluded.parent""",
        (json.dumps(params), json.dumps(RATIONALE), json.dumps(EVIDENCE)),
    )
    conn.commit()
    cur.execute("SELECT version, status, parent FROM scorecard_params WHERE lane='options' ORDER BY version")
    print(cur.fetchall())


if __name__ == "__main__":
    main()
