"""A244 Part C — the long-option paper track record.

S081's frozen screen and any S083 arm that cleared its pre-registered bar emit flags every day. Until now those flags
only ever reached `out/opt/S081_forward_ledger.jsonl`, which is gitignored and ungraded — Claude's S081 review called it
out: "local-only and ungraded → not a track record yet". This writes them into the **existing** forecast ledger as
`sim_structure` rows, the same path Rankings › Structures uses (S062), so `forecast_ledger._r_structure` grades each one
at expiry with no new grading code.

Why no study verdict changes here: S081 FAILED its bar and S083's stop rule may well leave nothing passing. A forward
paper ledger is not a product and makes no claim — it is the only clean out-of-sample left (S080's descriptive
hold-to-expiry number already saw 2025-07→), so it has to start accumulating before any later pass can be believed.

Encoding, so `_r_structure` needs no change: a long option is a structure with
    credit = −debit  ·  legs = [{side, strike, qty: +1}]
→ pnl at expiry = credit + qty × intrinsic = max(S_T − K, 0) − debit for a call. outcome = pnl > 0.
`prob` is the model's own break-even probability (lognormal at the entry iv30), so the ledger scores calibration too.

    cd scripts/watchlist_sync && .venv/bin/python long_option_ledger.py [--dry-run]
"""
from __future__ import annotations

import json
import math
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "analysis"))
from build_plan import connect  # noqa: E402
from forecast_ledger import UPSERT  # noqa: E402

FLAGS_S083 = HERE / "out" / "opt" / "S083_flags.json"
FLAGS_S086 = HERE / "out" / "opt" / "S086_flags.json"   # A244 strategy board: angles with analog t ≥ 2
LOOKBACK = 10          # the screen rebuilds the last ~2 weeks; only the latest bar is logged
SOURCES = ("S081", "S083")


def ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def breakeven_prob(side: str, S: float, K: float, debit: float, iv: float, dte: int) -> float:
    """P(the option finishes above its break-even) under the lognormal the entry iv30 implies. Calls need
    S_T > K + debit, puts need S_T < K − debit."""
    T = max(dte, 1) / 365
    sd = iv * math.sqrt(T)
    if sd <= 0:
        return 0.0
    b = K + debit if side == "call" else K - debit
    if b <= 0:
        return 1.0 if side == "put" else 0.0
    z = (math.log(S / b) - 0.5 * sd * sd) / sd
    return round(ncdf(z) if side == "call" else ncdf(-z), 4)


def s081_flags(conn) -> list[dict]:
    """Today's flags from S081's frozen rule, recomputed by S081's own build() so the ledger cannot drift from the
    backtest. Imported read-only — s081_long_options.py is owned by another agent's run."""
    import s080_long_options as S80
    import s081_long_options as S81

    px, rep, tb, tech_hi = S80.load(conn)
    scr, _ = S81.build(conn, px, rep, tb, tech_hi, screen_from=date.today() - timedelta(days=LOOKBACK))
    if not scr:
        return []
    last = max(x["d"] for x in scr)
    return [{"study": "S081", "arm": "S081", "ticker": x["t"], "date": x["d"], "side": x["side"], "spot": x["S"],
             "strike": x["K"], "expiry": x["e"], "dte": S81.DTE, "debit": x["debit"], "iv30": x["iv"]}
            for x in scr if x["d"] == last and x["signal"]]


def s083_flags(path: Path = FLAGS_S083, study: str = "S083") -> list[dict]:
    """Flags from any S083 arm that cleared its pre-registered bar. The file is written by every S083 run; an empty
    `entries` list is the normal case while the stop rule holds. S086 writes the same format."""
    if not path.exists():
        return []
    blob = json.loads(path.read_text())
    if study == "S086" and blob.get("as_of") != str(date.today()) and \
            (date.today() - date.fromisoformat(blob["as_of"])).days > 3:
        return []                                            # stale board: don't re-log old picks
    out = []
    for e in blob.get("entries", []):
        out.append({"study": study, "arm": e.get("arm", study), "ticker": e["ticker"],
                    "date": date.fromisoformat(e["date"]), "side": e["side"], "spot": e["spot"],
                    "strike": e["strike"], "expiry": date.fromisoformat(e["expiry"]), "dte": e["dte"],
                    "debit": e["model_debit"], "iv30": e["iv30"]})
    return out


def rows_for(flags: list[dict]) -> list[tuple]:
    rows = []
    for f in flags:
        sid = "long_call" if f["side"] == "call" else "long_put"
        qid = f"{f['arm']}:{sid}:{f['ticker']}:{f['expiry']}:{f['date']}"
        meta = json.dumps({"structure": sid, "credit": -round(f["debit"], 4), "spot": round(f["spot"], 4),
                           "legs": [{"side": f["side"], "strike": round(f["strike"], 4), "qty": 1,
                                     "expiry": str(f["expiry"]), "px": round(f["debit"], 4)}],
                           "from": str(f["date"]), "stock": False,
                           "arm": f["arm"], "study": f["study"], "dte": f["dte"], "iv30": round(f["iv30"], 4),
                           "exit_rule": "hold to expiry, intrinsic"}, default=str)
        q = (f"Will the {sid.replace('_', ' ')} on {f['ticker']} (exp {f['expiry']}) make money at expiry?")
        rows.append((qid, q, "sim_structure", f["ticker"],
                     breakeven_prob(f["side"], f["spot"], f["strike"], f["debit"], f["iv30"], f["dte"]),
                     datetime.now(), f["date"], f["expiry"], meta, f["arm"]))
    return rows


def main() -> int:
    dry = "--dry-run" in sys.argv[1:]
    conn = connect()
    flags: list[dict] = []
    try:
        flags += s081_flags(conn)
    except Exception as e:                                   # noqa: BLE001 — a screen failure must not break the daily run
        print(f"S081 screen unavailable: {e}")
    flags += s083_flags()
    flags += s083_flags(FLAGS_S086, "S086")

    rows = rows_for(flags)
    by_arm: dict[str, int] = {}
    for r in rows:
        by_arm[r[9]] = by_arm.get(r[9], 0) + 1
    if dry:
        for r in rows:
            print(r[0], r[4], json.loads(r[8])["credit"])
        print(f"[dry-run] {len(rows)} row(s): {by_arm or 'none'}")
        return len(rows)

    for r in rows:
        # forecaster = the arm, so a per-arm track record falls straight out of the ledger
        conn.execute(UPSERT, (r[0], r[1], r[2], r[3], r[9], r[4], r[5], r[6], r[7], r[8]))
    conn.commit()
    print(f"long-option ledger: {len(rows)} row(s) upserted {by_arm or '(no flags today)'}")
    return len(rows)


if __name__ == "__main__":
    main()
