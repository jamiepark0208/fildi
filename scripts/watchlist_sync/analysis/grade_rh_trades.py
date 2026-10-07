#!/usr/bin/env python3
"""Grade Robinhood realized option closes (portfolio_transactions) with premium-kept / tiers.

Uses txn_type=realized_close for Sell Puts / Sell Calls. Writes JSON summary to stdout
or --out path. Not wired into learn.py yet — analysis / Model List confidence only.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "research" / "wrds"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--since", default="2025-01-01")
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    try:
        from dotenv import load_dotenv
        import psycopg
    except ImportError as e:
        raise SystemExit("need psycopg + python-dotenv (research/wrds .venv)") from e

    for env in (ROOT / ".env.local", ROOT / ".env"):
        if env.is_file():
            load_dotenv(env, override=False)
    conn = psycopg.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    cur.execute(
        """
        SELECT UPPER(symbol), category, quantity::float8, price::float8, amount::float8, txn_date::date
        FROM portfolio_transactions
        WHERE txn_type='realized_close' AND category IN ('Sell Puts','Sell Calls')
          AND amount IS NOT NULL AND quantity IS NOT NULL AND quantity > 0
          AND txn_date::date >= %s::date
        ORDER BY txn_date
        """,
        (a.since,),
    )
    rows = list(cur.fetchall())
    syms = sorted({r[0] for r in rows})
    cur.execute(
        """
        SELECT ticker, date, close::float8 FROM prices_historical
        WHERE date >= %s::date - 60 AND ticker = ANY(%s) ORDER BY 1,2
        """,
        (a.since, syms),
    )
    px: dict[str, list] = defaultdict(list)
    for t, d, c in cur.fetchall():
        px[t].append((d, c))

    def close_on_or_before(series, d):
        best = None
        for dd, c in series:
            if dd <= d:
                best = (dd, c)
            else:
                break
        return best

    trades = []
    for sym, cat, qty, price, amount, d in rows:
        close_cost = abs(price) if price is not None else 0.0
        collected = amount + close_cost
        if collected <= 0 and amount > 0:
            collected = amount
        premium_kept = (amount / collected) if collected and collected > 0 else None
        spot_row = close_on_or_before(px.get(sym, []), d)
        spot = spot_row[1] if spot_row else None
        roc = (amount / (spot * 100 * qty)) if spot and qty else None
        series = px.get(sym, [])
        rets = []
        for i in range(1, len(series)):
            if series[i][0] > d:
                break
            if series[i][0] < d - timedelta(days=45):
                continue
            if series[i - 1][1] > 0:
                rets.append(math.log(series[i][1] / series[i - 1][1]))
        sig = None
        if len(rets) >= 10:
            m = sum(rets) / len(rets)
            v = sum((x - m) ** 2 for x in rets) / (len(rets) - 1)
            sig = math.sqrt(max(v, 0) * 252)
        sigma_move = (sig * math.sqrt(14 / 365)) if sig else None
        risk_adj = (roc / sigma_move) if (roc is not None and sigma_move and sigma_move > 0) else None

        if premium_kept is None:
            tier = "unknown"
        elif premium_kept >= 0.85 and amount > 0:
            tier = "best"
        elif premium_kept >= 0.5 and amount > 0:
            tier = "good"
        elif premium_kept < -0.5:
            tier = "very_bad"
        elif amount < 0:
            tier = "bad"
        else:
            tier = "flat"

        trades.append(
            {
                "symbol": sym,
                "cat": cat,
                "date": str(d),
                "qty": qty,
                "pnl": round(amount, 2),
                "collected": round(collected, 2) if collected else None,
                "premium_kept": round(premium_kept, 3) if premium_kept is not None else None,
                "roc": round(roc, 4) if roc is not None else None,
                "risk_adj": round(risk_adj, 3) if risk_adj is not None else None,
                "tier": tier,
            }
        )

    by_sym: dict[str, list] = defaultdict(list)
    for t in trades:
        by_sym[t["symbol"]].append(t)
    chronic = []
    for s, xs in by_sym.items():
        if len(xs) < 8:
            continue
        bad = sum(1 for t in xs if t["tier"] in ("bad", "very_bad")) / len(xs)
        good = sum(1 for t in xs if t["tier"] in ("best", "good")) / len(xs)
        chronic.append(
            {
                "sym": s,
                "n": len(xs),
                "bad_rate": round(bad, 3),
                "good_rate": round(good, 3),
                "very_bad": sum(1 for t in xs if t["tier"] == "very_bad"),
                "pnl": round(sum(t["pnl"] for t in xs), 1),
            }
        )
    chronic.sort(key=lambda x: (-x["bad_rate"], x["sym"]))
    # Option P&L alone hides assigned-stock losses (OPEN: +$2.3k options, -$7.7k stock). Attach the whole wheel.
    import wheel as WH
    wheel = WH.wheel_pnl(conn)
    for c in chronic:
        w = wheel.get(c["sym"]) or {}
        c["wheel_total"] = w.get("total")
        c["stock_pnl"] = (w["stock_realized"] + w["stock_unrealized"]) if w else None

    out = {
        "as_of": str(date.today()),
        "since": a.since,
        "n": len(trades),
        "by_tier": dict(Counter(t["tier"] for t in trades)),
        "puts": {
            "n": sum(1 for t in trades if t["cat"] == "Sell Puts"),
            "pnl": round(sum(t["pnl"] for t in trades if t["cat"] == "Sell Puts"), 1),
            "wr": round(
                sum(1 for t in trades if t["cat"] == "Sell Puts" and t["pnl"] > 0)
                / max(1, sum(1 for t in trades if t["cat"] == "Sell Puts")),
                3,
            ),
        },
        "calls": {
            "n": sum(1 for t in trades if t["cat"] == "Sell Calls"),
            "pnl": round(sum(t["pnl"] for t in trades if t["cat"] == "Sell Calls"), 1),
            "wr": round(
                sum(1 for t in trades if t["cat"] == "Sell Calls" and t["pnl"] > 0)
                / max(1, sum(1 for t in trades if t["cat"] == "Sell Calls")),
                3,
            ),
        },
        "chronic": chronic[:15],
        "wheel_losers": sorted(
            [{"sym": t, **w} for t, w in wheel.items() if w["total"] is not None and w["total"] < 0],
            key=lambda x: x["total"],
        ),
        "heroes": sorted(
            [
                {
                    "date": t["date"],
                    "sym": t["symbol"],
                    "cat": t["cat"],
                    "pk": t["premium_kept"],
                    "pnl": t["pnl"],
                    "collected": t["collected"],
                }
                for t in trades
                if t["tier"] == "best"
            ],
            key=lambda x: -(x["pk"] or 0),
        )[:12],
        "villains": sorted(
            [
                {
                    "date": t["date"],
                    "sym": t["symbol"],
                    "cat": t["cat"],
                    "pk": t["premium_kept"],
                    "pnl": t["pnl"],
                    "collected": t["collected"],
                }
                for t in trades
                if t["tier"] == "very_bad"
            ],
            key=lambda x: (x["pk"] or 0),
        )[:12],
        "notes": {
            "factor_candidates": [
                "Covered-call buybacks on momentum names (tiny credit, huge debit) — HOOD cluster",
                "Sell-puts with collected≥$60 keep higher win rate than scrap premium",
                "Expire-worthless / ≥85% premium kept is the dominant 'best' pattern",
            ],
            "likely_noise": [
                "Weekday of close",
                "Single-name streaks with n<8",
                "Tiny $3–15 credits that expire (looks like pk=1.0 but not a process edge)",
            ],
        },
    }
    text = json.dumps(out, indent=2)
    if a.out:
        Path(a.out).write_text(text)
        print(f"wrote {a.out} n={out['n']}")
    else:
        print(text)


if __name__ == "__main__":
    main()
