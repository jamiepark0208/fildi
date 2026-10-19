"""Strategy Library runner (A176; page = A175 Track Record › Strategies).

Each strategy = meta dict + a function returning trades. The runner turns trades into a daily equity curve and writes
watchlist_sync.strategies / strategy_trades / strategy_equity (delete + insert per strategy version → idempotent).

Equity = one book per expiry week: week return = Σ pnl ÷ Σ capital of trades settling that ISO week (same unit as the
A171 scoreboard), compounded, forward-filled on SPY trading days. SPY line = buy-and-hold from the window's first day.

    cd scripts/watchlist_sync && .venv/bin/python analysis/strategy_lib.py [--write]   # nightly via option_history.py
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

START = date(2026, 1, 1)
CLOSE = time(16, 0)
NY = ZoneInfo("America/New_York")


def ts(d: date) -> datetime:
    return datetime.combine(d, CLOSE, NY)


def ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def settle_close(conn, ticker: str, d: date):
    r = conn.execute("SELECT close::float FROM prices_historical WHERE ticker = %s AND date <= %s ORDER BY date DESC LIMIT 1",
                     (ticker, d)).fetchone()
    return r[0] if r else None


# ── Strategies ────────────────────────────────────────────────────────────────────────────────────────────────────────

def your_puts(account: str):
    def run(conn):
        rows = conn.execute("""SELECT ticker, d0, expiry, strike::float, premium::float, qty::float, closed_early
                               FROM optlab.trades WHERE account = %s AND expiry < current_date AND d0 >= %s ORDER BY d0""",
                            (account, START)).fetchall()
        out = []
        for t, d0, e, k, prem, q, early in rows:
            st = settle_close(conn, t, e)
            if st is None or k <= 0:
                continue
            intr = max(0.0, k - st)
            pnl = (prem - intr) * q
            app = "app-guided (Model List live)" if d0 >= date(2026, 10, 5) else "your own pick"
            out.append(dict(entry_ts=ts(d0), exit_ts=ts(e), ticker=t, instrument="option", side="short", option_type="P",
                            strike=k, expiry=e, dte_at_entry=(e - d0).days, qty=q, entry_px=prem, exit_px=intr,
                            capital=k * q, pnl=pnl, ret_pct=pnl / (k * q),
                            trigger=f"{account} short put — {app}",
                            exit_reason="held to expiry (replay; you closed it early)" if early else "held to expiry"))
        return out
    return run


def index_1sigma_puts(conn):
    """Every week's first trading day: sell a put 1σ (iv30_put) below spot on SPY and QQQ, expiring that week's last
    trading day. Priced with Black-Scholes at LSEG iv30_put (no skew) → model price."""
    out = []
    for t in ("SPY", "QQQ"):
        h = conn.execute("""SELECT date, close::float, iv30_put::float FROM lseg_research.daily_history
                            WHERE ticker = %s AND date >= %s ORDER BY date""", (t, START)).fetchall()
        weeks = defaultdict(list)
        for d, c, iv in h:
            weeks[d.isocalendar()[:2]].append((d, c, iv))
        last_wk = max(weeks)
        for wk, days in weeks.items():
            if wk == last_wk or len(days) < 2:  # current week hasn't settled
                continue
            (d0, S, iv), (e, ST, _) = days[0], days[-1]
            if not iv:
                continue
            v, tt = iv / 100, (e - d0).days / 365
            sd = v * math.sqrt(tt)
            K = S * math.exp(-sd)
            d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
            prem = K * ncdf(-(d1 - sd)) - S * ncdf(-d1)
            intr = max(0.0, K - ST)
            pnl = (prem - intr) * 100
            out.append(dict(entry_ts=ts(d0), exit_ts=ts(e), ticker=t, instrument="option", side="short", option_type="P",
                            strike=round(K, 2), expiry=e, dte_at_entry=(e - d0).days, qty=100, entry_px=prem, exit_px=intr,
                            capital=K * 100, pnl=pnl, ret_pct=pnl / (K * 100),
                            trigger=f"weekly rule: 1σ put (IV {iv:.1f} %)", exit_reason="held to expiry"))
    return out


PUT_CAVEATS = ("- Replay holds every put to expiry and settles at the expiry close; your real exits differ "
               "(S017: holding ≥ closing early on average).\n- Premium = your actual fill.\n"
               "- Week return = P&L ÷ collateral of puts expiring that week, compounded; assumes the full book is collateral.")

STRATEGIES = [
    dict(strategy_id="ira-puts", version="1", name="Your IRA short puts", family="options-income", instrument="option",
         status="live", study_ref="A171",
         summary="Every short put you sold in the IRA in 2026, replayed to expiry on your real fills.",
         rules_md="Your own entries, nothing simulated: each IRA cash-secured put from `optlab.trades`, premium = your fill, "
                  "settled at the underlying's close on expiry day. From 10-05 on, picks were app-guided (Model List).",
         caveats_md=PUT_CAVEATS, price_source="real_quote", holdout_start=None, run=your_puts("IRA")),
    dict(strategy_id="fildi-puts", version="1", name="Your FILDI-account short puts", family="options-income",
         instrument="option", status="live", study_ref="S012",
         summary="Every short put in the FILDI account in 2026, replayed to expiry on your real fills.",
         rules_md="Same as the IRA replay, FILDI account.", caveats_md=PUT_CAVEATS, price_source="real_quote",
         holdout_start=None, run=your_puts("FILDI")),
    dict(strategy_id="index-1sigma-puts", version="1", name="Index 1σ weekly puts (SPY + QQQ)", family="index",
         instrument="option", status="candidate", study_ref="A171",
         summary="Naive benchmark: every Monday sell a put 1σ below SPY and QQQ, expiring Friday.",
         rules_md="First trading day of each week: strike = spot × exp(−IV30·√(days/365)), expiry = that week's last trading "
                  "day, one contract each on SPY and QQQ, held to expiry.",
         caveats_md="- **Model-priced** (Black-Scholes at LSEG iv30_put, no skew). S021: model premiums ran ~25 % cheap vs real "
                    "closes, so this understates the benchmark.\n- No fills, fees or early assignment.",
         price_source="model", holdout_start=None, run=index_1sigma_puts),
]


# ── Runner ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def equity(trades, spy, holdout_start, bankroll=None):
    """bankroll set (long-option lanes) → equity = 1 + cumulative pnl ÷ bankroll, no compounding."""
    wk = defaultdict(lambda: [0.0, 0.0, None])
    for t in trades:
        e = t["exit_ts"].date()
        w = wk[e.isocalendar()[:2]]
        w[0] += t["pnl"]
        w[1] += t["capital"]
        w[2] = max(w[2] or e, e)
    step = {w[2]: (w[0] / bankroll if bankroll else w[0] / w[1]) for w in wk.values() if w[1] > 0}
    first = min(t["entry_ts"].date() for t in trades)
    last = max(step)
    days = [(d, c) for d, c in spy if first <= d <= last]
    eq, peak, out, base = 1.0, 1.0, [], days[0][1]
    pending = sorted(step.items())
    for d, c in days:
        while pending and pending[0][0] <= d:
            r = pending.pop(0)[1]
            eq = eq + r if bankroll else eq * (1 + r)
        peak = max(peak, eq)
        out.append((d, eq, c / base, eq / peak - 1, bool(holdout_start and d >= holdout_start)))
    return out, step


def write_rows(conn, s, trades, eq):
    sid, ver = s["strategy_id"], s["version"]
    conn.execute("DELETE FROM watchlist_sync.strategies WHERE strategy_id = %s AND version = %s", (sid, ver))
    conn.execute("""INSERT INTO watchlist_sync.strategies (strategy_id, version, name, family, instrument, status, summary,
                    rules_md, caveats_md, study_ref, window_start, window_end, holdout_start, price_source)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                 (sid, ver, s["name"], s["family"], s["instrument"], s["status"], s["summary"], s["rules_md"],
                  s["caveats_md"], s["study_ref"], eq[0][0], eq[-1][0], s["holdout_start"], s["price_source"]))
    cols = ["entry_ts", "exit_ts", "ticker", "instrument", "side", "option_type", "strike", "expiry", "dte_at_entry", "qty",
            "entry_px", "exit_px", "capital", "pnl", "ret_pct", "trigger", "exit_reason"]
    hs = s["holdout_start"]
    with conn.cursor() as cur:
        cur.executemany(
            f"INSERT INTO watchlist_sync.strategy_trades (strategy_id, version, {', '.join(cols)}, is_holdout) "
            f"VALUES (%s, %s, {', '.join(['%s'] * len(cols))}, %s)",
            [(sid, ver, *[t[c] for c in cols], bool(hs and t["entry_ts"].date() >= hs)) for t in trades])
        cur.executemany("INSERT INTO watchlist_sync.strategy_equity VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        [(sid, ver, *row) for row in eq])


def main(write: bool = False) -> None:
    conn = connect()
    spy = [(d, float(c)) for d, c in conn.execute(
        "SELECT date, close FROM prices_historical WHERE ticker = 'SPY' AND date >= %s ORDER BY date", (START,)).fetchall()]
    results = {}
    for s in STRATEGIES:
        trades = s["run"](conn)
        if not trades:
            print(f"{s['strategy_id']}: no trades — skipped")
            continue
        eq, step = equity(trades, spy, s["holdout_start"])
        mean_bp = sum(step.values()) / len(step) * 1e4
        results[s["strategy_id"]] = mean_bp
        print(f"{s['strategy_id']}: {len(trades)} trades · {len(step)} weeks · mean week {mean_bp:+.1f} bp · "
              f"total {eq[-1][1] - 1:+.1%} vs SPY {eq[-1][2] - 1:+.1%} · max DD {min(r[3] for r in eq):.1%}")
        if write:
            write_rows(conn, s, trades, eq)
    # Reconcile (A176 step 4): the IRA replay must match the A171 scoreboard's per-week number within 5 %.
    import scoreboard
    sb = scoreboard.ira_vs_benchmark(conn)[-1].get("ira_bp")
    if sb is not None and "ira-puts" in results:
        gap = abs(results["ira-puts"] - sb) / abs(sb)
        print(f"reconcile ira-puts vs scoreboard: {results['ira-puts']:+.1f} vs {sb:+.1f} bp → {'OK' if gap <= 0.05 else 'GAP'}"
              f" ({gap:.1%})")
        if gap > 0.05 and write:
            conn.rollback()
            sys.exit("reconciliation gap > 5 % — nothing written")
    conn.commit()


if __name__ == "__main__":
    main("--write" in sys.argv)
