"""Pick odds (Jamie 10-20): probabilities for each Model List put, each tagged with the evidence behind it.

Per shown sell_puts pick of the latest plan → watchlist_sync.pick_odds (plan_id, ticker, odds jsonb) + out/odds/latest.md.
  p_itm        finish in the money = market odds N(−d2) × 1.14 (S016: realized/predicted on 926 real puts) × put-edge factor
               (S059 holdout breach of the pick's quintile ÷ mean of all quintiles; 1.0 when no put-edge inputs)
  p_otm        1 − p_itm
  p_profit     finish above breakeven (strike − premium), same calibration
  p_touch      trade below the strike at some point before expiry ≈ 2 × p_itm (reflection principle, driftless), capped at 1
  range_68/95  expiry price band ±1σ / ±2σ at the option's IV
  if_assigned  S064 (holdout 2024-07→, all anchors): share of assigned puts whose stock was back above the strike 63 sessions
               after entry, and share that still made money incl. premium
  bounce_5d    base rate: share of the stock's 5-day windows (3 y) that ended up — S025: after a 2σ drop the bounce odds are the
               SAME as this base rate (no reversal edge), so it's shown as context, never as a signal
Evidence tags: calibrated (checked on real outcomes) · backtest · base rate.

    .venv/bin/python pick_odds.py          # after the plan is built (daily.py)
"""
from __future__ import annotations

import json
import math
import sys
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

S016_RATIO = 1.14  # realized ITM ÷ market-predicted, 926 real puts (S016)
CAL = json.loads((HERE / "put_edge_calibration.json").read_text())["quintiles"]
MEAN_BREACH = sum(q["breach"] for q in CAL.values()) / len(CAL)
OUT = HERE / "out" / "odds" / "latest.md"
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.pick_odds (plan_id int NOT NULL, ticker text NOT NULL, odds jsonb NOT NULL,
  computed_at timestamptz DEFAULT now(), PRIMARY KEY (plan_id, ticker))"""


def ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def p_below(S: float, K: float, iv: float, T: float) -> float:
    """Market (risk-neutral, zero-rate) probability that the stock finishes below K."""
    sd = iv * math.sqrt(T)
    return ncdf(-(math.log(S / K) - 0.5 * sd * sd) / sd)


def if_assigned() -> dict:
    """From S064 trade output (local JSON); None if the study hasn't been run on this machine."""
    f = HERE / "out" / "opt" / "S064_bs.json"
    if not f.exists():
        return {}
    tr = [x for x in json.loads(f.read_text()) if x["assigned"] and x["d"] >= "2024-07-01"]
    if not tr:
        return {}
    return {"n": len(tr), "back_above_strike_63d": sum(x["S63"] >= x["K"] for x in tr) / len(tr),
            "net_positive_63d": sum(x["put"] >= 0 for x in tr) / len(tr), "evidence": "backtest S064 (holdout, modelled fills)"}


def bounce_base(conn, t: str) -> float | None:
    c = [r[0] for r in conn.execute("SELECT close::float FROM lseg_research.daily_history WHERE ticker = %s AND close > 0 "
                                    "AND date >= %s ORDER BY date", (t, date.today() - timedelta(days=3 * 365))).fetchall()]
    w = [c[i + 5] > c[i] for i in range(0, len(c) - 5)]
    return sum(w) / len(w) if len(w) > 100 else None


POS_DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.position_odds (snapshot_id int NOT NULL, account text NOT NULL, ticker text NOT NULL,
  strike numeric NOT NULL, expiry date NOT NULL, odds jsonb NOT NULL, computed_at timestamptz DEFAULT now(),
  PRIMARY KEY (snapshot_id, account, ticker, strike, expiry))"""


def put_odds(conn, t, K, e, prem, S, iv, edge, asg) -> dict:
    T = max(1, (e - date.today()).days) / 365
    q = (edge.get(t) or {}).get("quintile")
    f_edge = CAL[str(q)]["breach"] / MEAN_BREACH if q else 1.0
    p_itm = min(0.99, p_below(S, K, iv, T) * S016_RATIO * f_edge)
    p_loss = min(0.99, p_below(S, K - (prem or 0), iv, T) * S016_RATIO * f_edge)
    sd = iv * math.sqrt(T)
    return {
        "strike": K, "expiry": str(e), "spot": S, "iv": iv,
        "p_otm": {"value": 1 - p_itm, "evidence": "calibrated: market odds × 1.14 (S016)" + (f" × put-edge Q{q} {f_edge:.2f} (S059)" if q else "")},
        "p_profit": {"value": 1 - p_loss, "evidence": "calibrated, breakeven = strike − premium"},
        "p_touch": {"value": min(1.0, 2 * p_itm), "evidence": "model: 2 × P(ITM), reflection principle"},
        "range_68": [S * math.exp(-sd), S * math.exp(sd)], "range_95": [S * math.exp(-2 * sd), S * math.exp(2 * sd)],
        "if_assigned": asg,
        "bounce_5d": {"value": bounce_base(conn, t), "evidence": "base rate (3 y); S025: no reversal edge after big drops"},
    }


def row(t, K, e, odds) -> str:
    b, a = odds["bounce_5d"]["value"], odds["if_assigned"].get("back_above_strike_63d")
    return (f"| {t} | ${K:g} {e:%m-%d} | {odds['p_otm']['value']:.0%} | {odds['p_profit']['value']:.0%} | {odds['p_touch']['value']:.0%} | "
            f"${odds['range_68'][0]:.2f}–{odds['range_68'][1]:.2f} | {'—' if a is None else f'{a:.0%}'} | {'—' if b is None else f'{b:.0%}'} |")


def main() -> None:
    import put_edge as PE
    conn = connect()
    conn.execute(DDL)
    pid = conn.execute("SELECT max(id) FROM watchlist_sync.plans").fetchone()[0]
    picks = conn.execute("""SELECT ticker, strike::float, expiry, model_premium::float, model_spot::float, model_iv::float
                            FROM watchlist_sync.plan_items WHERE plan_id = %s AND list_key = 'sell_puts' AND l1_pass
                            AND verify_status <> 'fail' AND strike IS NOT NULL ORDER BY rank""", (pid,)).fetchall()
    edge = PE.scores(conn)
    asg = if_assigned()
    L = [f"# Pick odds — plan {pid}", "", "| ticker | strike / expiry | P(expire OTM) | P(profit) | P(touch strike) | 68 % range | if assigned: back above strike in 63 d | 5-day up base rate |",
         "|---|---|---|---|---|---|---|---|"]
    for t, K, e, prem, S, iv in picks:
        odds = put_odds(conn, t, K, e, prem, S, iv, edge, asg)
        conn.execute("INSERT INTO watchlist_sync.pick_odds (plan_id, ticker, odds) VALUES (%s, %s, %s) ON CONFLICT (plan_id, ticker) "
                     "DO UPDATE SET odds = EXCLUDED.odds, computed_at = now()", (pid, t, json.dumps(odds)))
        L.append(row(t, K, e, odds))
    # Open short puts you already hold (latest Robinhood snapshot): same odds, live strike/expiry → watchlist_sync.position_odds
    conn.execute(POS_DDL)
    snap = conn.execute("SELECT max(id) FROM portfolio_snapshots").fetchone()[0]
    pos = conn.execute("""SELECT o.account, UPPER(o.symbol), o.strike::float, o.expiration, o.avg_premium::float / 100, o.iv::float,  -- $/contract → $/share
                                 (SELECT close::float FROM prices_historical p WHERE UPPER(p.ticker) = UPPER(o.symbol) ORDER BY date DESC LIMIT 1)
                          FROM portfolio_options o WHERE o.snapshot_id = %s AND o.direction = 'short' AND o.option_type = 'put'
                          AND o.expiration >= CURRENT_DATE""", (snap,)).fetchall()
    L += ["", f"## Open short puts (snapshot {snap})", "", L[2], L[3]]
    for acct, t, K, e, prem, iv, S in pos:
        if not (S and iv):
            continue
        odds = put_odds(conn, t, K, e, prem, S, iv if iv < 5 else iv / 100, edge, asg)
        conn.execute("INSERT INTO watchlist_sync.position_odds (snapshot_id, account, ticker, strike, expiry, odds) VALUES (%s,%s,%s,%s,%s,%s) "
                     "ON CONFLICT (snapshot_id, account, ticker, strike, expiry) DO UPDATE SET odds = EXCLUDED.odds, computed_at = now()",
                     (snap, acct, t, K, e, json.dumps(odds)))
        L.append(row(t, K, e, odds))
    conn.commit()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
