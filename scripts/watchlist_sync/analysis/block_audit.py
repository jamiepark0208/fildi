"""Block audit: were the Robinhood verify blocks right? Grade every verified contract at expiry as if it had been sold.

Each L2-verified plan item (pass or fail) is settled from the real close on its expiry day:
  P&L/share = realistic fill (Robinhood high_fill_rate_sell_price, ≈ bid + ¼ of the spread) − intrinsic at expiry
  return on collateral = P&L / strike (puts) or / spot (calls)
Rows are grouped by outcome group: passed, and each blocking check (a row blocked by two checks counts in both).
A check that keeps blocking trades that would have made money is costing income → loosen it; one whose blocked trades
lose more than the passed ones is earning its keep. Decide only once a group has ≥ 30 graded rows.

Read-only; writes out/block_audit/report.md. Runs in daily.py after the grade ledger.
    .venv/bin/python analysis/block_audit.py
"""
from __future__ import annotations

import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date
from pathlib import Path
from statistics import mean

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "block_audit"
MIN_ROWS = 30


def close_on(conn, tickers: list[str]) -> dict[str, list[tuple[date, float]]]:
    px = defaultdict(list)
    for r in rows(conn, """SELECT ticker, date, close::float8 c FROM prices_historical
                           WHERE ticker = ANY(%s) AND date >= CURRENT_DATE - 120 ORDER BY ticker, date""", (tickers,)):
        px[r["ticker"]].append((r["date"], r["c"]))
    return px


def settle(s: list[tuple[date, float]], expiry: date) -> float | None:
    ds = [d for d, _ in s]
    i = bisect_right(ds, expiry) - 1
    return s[i][1] if i >= 0 and ds[i] == expiry else None


def graded(conn) -> list[dict]:
    items = rows(conn, """SELECT plan_id, ticker, option_type, strike::float8 strike, expiry, model_spot::float8 spot,
                                 verify_status, verify_checks, live
                          FROM watchlist_sync.plan_items
                          WHERE kind = 'option' AND verify_checks IS NOT NULL AND expiry < CURRENT_DATE""")
    px = close_on(conn, sorted({i["ticker"] for i in items}))
    out = []
    for it in items:
        live = it["live"] or {}
        fill = live.get("realistic_fill") or live.get("bid")
        st = settle(px.get(it["ticker"], []), it["expiry"])
        if not fill or st is None:
            continue
        k = it["strike"]
        intrinsic = max(k - st, 0) if it["option_type"] == "put" else max(st - k, 0)
        base = k if it["option_type"] == "put" else (live.get("spot") or it["spot"] or k)
        blocks = [c["check"] for c in it["verify_checks"] if not c["pass"] and c.get("severity") == "block"]
        out.append({**it, "ret": (fill - intrinsic) / base, "breach": intrinsic > 0, "blocks": blocks})
    return out


def report() -> None:
    with connect() as conn:
        gs = graded(conn)
    groups: dict[str, list[dict]] = defaultdict(list)
    for g in gs:
        for b in g["blocks"] or ["passed"]:
            groups[b].append(g)
    lines = ["# Block audit: verify outcomes graded at expiry", "",
             f"{len(gs)} verified contracts have expired. Return = (realistic fill − intrinsic) ÷ collateral, as if sold and held.",
             f"Verdict needs ≥ {MIN_ROWS} rows per group.", "",
             "| group | rows | mean return | win rate | breach rate | worst | read |", "|---|---|---|---|---|---|---|"]
    passed = groups.get("passed", [])
    p_mean = mean(g["ret"] for g in passed) if passed else None
    for name, xs in sorted(groups.items(), key=lambda kv: (kv[0] != "passed", kv[0])):
        m = mean(x["ret"] for x in xs)
        if len(xs) < MIN_ROWS:
            read = "too few rows"
        elif name == "passed":
            read = "baseline"
        elif p_mean is not None and m >= p_mean:
            read = "blocked trades did as well as passed ones → candidate to loosen"
        else:
            read = "blocks are saving money → keep"
        lines.append(f"| {name} | {len(xs)} | {m:+.2%} | {mean(x['ret'] > 0 for x in xs):.0%} | "
                     f"{mean(x['breach'] for x in xs):.0%} | {min(x['ret'] for x in xs):+.1%} | {read} |")
    if gs:
        lines += ["", "| plan | ticker | contract | blocks | return |", "|---|---|---|---|---|"]
        for g in sorted(gs, key=lambda g: (g["plan_id"], g["ticker"])):
            lines.append(f"| {g['plan_id']} | {g['ticker']} | {g['strike']:g}{g['option_type'][0].upper()} {g['expiry']} | "
                         f"{', '.join(g['blocks']) or 'passed'} | {g['ret']:+.2%} |")
    text = "\n".join(lines) + "\n"
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "report.md").write_text(text)
    print(text)


if __name__ == "__main__":
    report()
