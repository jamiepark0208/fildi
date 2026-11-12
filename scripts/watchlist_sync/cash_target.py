"""A372 § 2 — one broad-market cash/collateral target, identical for every account (Jamie 11-11).

Answers "how much of the cash-vs-short-put allocation should sit in cash in THIS market?" Inputs are market-wide only
(S057 panel: S&P 500 drawdown from its 1-year high, VIX vs its 1-year median, below the 200-day, 5-day move, BAA credit
spread wide). No holdings, balances, debt, tickers or account ids enter — cash_moves.py translates the target per account.

POLICY = Jamie's stated preference (rebuild cash into rallies, deploy part of it after a large selloff, keep a reserve when
stress is disorderly). The percentages are a PREFERENCE, not an estimated optimum: A372 § 6 has not run (≈ 9 regime
episodes since 2000 < 30 → "can't confirm" at this n). Versioned so a later calibration never redraws issued targets.

    target = regime level, moved at most STEP points per trading day toward it (hysteresis, no whipsaw)
Append-only: watchlist_sync.cash_target keeps the first value issued for (as_of, policy) — later runs never overwrite it.
History (out/cash_target/history.json) is the same rule replayed on 1990→ data, labelled counterfactual.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out" / "cash_target"

POLICY = {
    "version": "cash-target-0.1",
    "kind": "preference",   # not calibrated (A372 § 6 pending)
    "levels": {"extended": 0.60, "normal": 0.50, "downtrend": 0.50, "pullback": 0.40, "selloff": 0.25, "stress": 0.45},
    "band": 0.05,           # ± shown around the target
    "step": 0.05,           # max move per trading day
    "dd_pullback": 0.05, "dd_selloff": 0.10, "dd_extended": 0.02, "vix_stress": 0.60,
}
LABEL = {"extended": "Extended rally", "normal": "Normal", "downtrend": "Below 200-day (relief rally risk)",
         "pullback": "Ordinary pullback", "selloff": "Large selloff", "stress": "Disorderly stress"}
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.cash_target (
  as_of date NOT NULL, policy_version text NOT NULL, known_at timestamptz NOT NULL DEFAULT now(),
  target double precision NOT NULL, lo double precision NOT NULL, hi double precision NOT NULL, regime text NOT NULL,
  direction text NOT NULL, reasons jsonb NOT NULL, features jsonb NOT NULL, PRIMARY KEY (as_of, policy_version))"""


def regime(f: dict, P: dict = POLICY) -> tuple[str, list[str]]:
    """Market features → regime + plain reasons. f: dd (0–1 off 1-y high), vix_z (log VIX / 1-y median), below200, credit, ret5_z."""
    dd, vz = f["dd"], f["vix_z"]
    r = [f"S&P {100 * dd:.1f} % below its 1-year high", f"VIX {100 * (pow(2.718281828, vz) - 1):+.0f} % vs its 1-year median"]
    if f.get("credit"):
        r.append("credit spreads wide (BAA top 20 % of the year)")
    if f.get("below200"):
        r.append("S&P below its 200-day average")
    if dd >= P["dd_selloff"] and (f.get("credit") or vz >= P["vix_stress"]):
        return "stress", r + ["deep drop with stress still rising → keep a reserve, don't deploy everything"]
    if dd >= P["dd_selloff"]:
        return "selloff", r + ["large drop, stress contained → put premium pays most here: deploy part of the cash"]
    if dd >= P["dd_pullback"]:
        return "pullback", r + ["ordinary pullback → start using some cash"]
    if f.get("below200"):
        return "downtrend", r + ["small drop but trend is down → a bounce may be a relief rally; hold the normal reserve"]
    if dd < P["dd_extended"] and vz < 0:
        return "extended", r + ["near highs with calm VIX → extra put premium is thin: rebuild cash"]
    return "normal", r


def step(prev: float | None, level: float, P: dict = POLICY) -> float:
    if prev is None:
        return level
    return prev + max(-P["step"], min(P["step"], level - prev))


def direction(prev: float | None, tgt: float) -> str:
    if prev is None or abs(tgt - prev) < 1e-9:
        return "maintain"
    return "raise cash" if tgt > prev else "deploy cash"


def replay(panel: list[dict], P: dict = POLICY) -> list[dict]:
    """Counterfactual line: the rule applied day by day on market data known at each date."""
    out, prev = [], None
    for row in panel:
        g, _ = regime(row, P)
        t = step(prev, P["levels"][g], P)
        out.append({"d": str(row["d"]), "target": round(t, 4), "regime": g})
        prev = t
    return out


def compute(panel: list[dict], P: dict = POLICY) -> dict:
    hist = replay(panel, P)
    last, prev = panel[-1], (hist[-2]["target"] if len(hist) > 1 else None)
    g, reasons = regime(last, P)
    t = hist[-1]["target"]
    lvl = P["levels"][g]
    if abs(t - lvl) > 1e-9:
        reasons = reasons + [f"moving toward {lvl:.0%} at ≤ {P['step']:.0%}/day"]
    return {"as_of": str(last["d"]), "policy_version": P["version"], "policy_kind": P["kind"], "target": t,
            "lo": max(t - P["band"], 0), "hi": min(t + P["band"], 1), "regime": g, "regime_label": LABEL[g],
            "direction": direction(prev, t), "reasons": reasons,
            "features": {k: round(float(last[k]), 4) for k in ("dd", "vix_z", "below200", "credit", "ret5_z")},
            "history": hist}


def persist(conn, tgt: dict) -> None:
    conn.execute(DDL)
    conn.execute("""INSERT INTO watchlist_sync.cash_target (as_of, policy_version, target, lo, hi, regime, direction, reasons, features)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (as_of, policy_version) DO NOTHING""",
                 (tgt["as_of"], tgt["policy_version"], tgt["target"], tgt["lo"], tgt["hi"], tgt["regime"], tgt["direction"],
                  json.dumps(tgt["reasons"]), json.dumps(tgt["features"])))
    OUT.mkdir(parents=True, exist_ok=True)
    weekly = [h for i, h in enumerate(tgt["history"]) if i % 5 == 0 or i == len(tgt["history"]) - 1]
    (OUT / "history.json").write_text(json.dumps({"policy_version": tgt["policy_version"], "counterfactual": True,
                                                  "generated": datetime.now().isoformat(timespec="seconds"), "points": weekly}))


def issued(conn, limit: int = 400) -> list[dict]:
    from build_plan import rows
    return rows(conn, """SELECT as_of, target, lo, hi, regime, direction, reasons, known_at FROM watchlist_sync.cash_target
                         WHERE policy_version = %s ORDER BY as_of DESC LIMIT %s""", (POLICY["version"], limit))


def main():
    sys.path.insert(0, str(HERE / "analysis"))
    import s057_market_view as V
    from build_plan import connect
    V.refresh_gspc()
    tgt = compute(V.panel())
    with connect() as conn:
        persist(conn, tgt)
        conn.commit()
    print(f"cash target {tgt['as_of']}: {tgt['target']:.0%} cash ({tgt['regime_label']}, {tgt['direction']}) · "
          + "; ".join(tgt["reasons"]))


if __name__ == "__main__":
    main()
