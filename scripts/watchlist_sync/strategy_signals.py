"""Live triggers for adopted Strategy Library rules + forward grading (A178/A189). Runs nightly in daily.py (publish stage, LSEG venv),
after LSEG daily_history is refreshed.

panic-puts-hiv (S049/S054): on the latest LSEG close, a ≥ 2σ 5-day drop (S025/S049 event rule, one per name per 10 days)
with iv30_put > 48.7 → signal. Contract = S049's pick_contract (monthly put nearest 0.20Δ, ~30 DTE) priced with the
LSEG mid on the next session (Schwab snapshots only hold 3–14 DTE puts). Graded after expiry: pnl ÷ strike from the entry mid and intrinsic at the expiry close (LSEG).
Rows: watchlist_sync.strategy_signals (read by the Strategies tab / Options board badge, A189).

A330 shadow challengers (S151 Phase 4): put_climax_spy_oversold · put_climax_low_ivrv — logged + graded only; panic rows unchanged.

    ../../research/lseg/.venv/bin/python strategy_signals.py [--asof=YYYY-MM-DD]
"""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE / "analysis")]
from build_plan import connect  # noqa: E402
import s049_panic_puts as P  # noqa: E402  (one home for the event rule)
import pattern_lab as PL  # noqa: E402
from backtest_lab import PRESETS, preset_fires  # noqa: E402

IV_MIN = 48.7
SHADOW = {
    "put_climax_spy_oversold": {"delta": -0.08, "exit": "half_dte", "preset": "put_climax_spy_oversold"},
    "put_climax_low_ivrv": {"delta": -0.08, "exit": "stop50", "preset": "put_climax_low_ivrv"},
}
DDL = """
CREATE TABLE IF NOT EXISTS watchlist_sync.strategy_signals (
  strategy_id text NOT NULL, as_of date NOT NULL, ticker text NOT NULL,
  trigger text NOT NULL, details jsonb,
  occ text, expiry date, strike double precision, entry_mid double precision, entry_date date,
  status text NOT NULL DEFAULT 'open',          -- open | priced | graded | no_contract
  settle double precision, ret double precision, itm boolean, graded_at timestamptz,
  PRIMARY KEY (strategy_id, as_of, ticker));
"""


def detect(conn, asof: date | None):
    rows = {}
    for t, d, c, iv in conn.execute("""SELECT ticker, date, close::float, iv30_put::float FROM lseg_research.daily_history
                                       WHERE close > 0 AND date >= current_date - 150 ORDER BY ticker, date""").fetchall():
        if t not in P.FUNDS:
            rows.setdefault(t, []).append((d, c, iv))
    last = max(r[-1][0] for r in rows.values())
    asof = asof or last
    old_start, P.START = P.START, asof - timedelta(days=20)  # events() only emits days ≥ START; 10-day spacing needs history
    ev = P.events({t: [x for x in r if x[0] <= asof] + [(asof + timedelta(days=1), None, None)] for t, r in rows.items()})
    P.START = old_start
    out = []
    grp = dict(conn.execute("SELECT ticker, primary_peer_group_id FROM ticker_registry").fetchall())
    for t, lst in ev.items():
        r = rows[t]
        for i, z in lst:
            if i >= len(r) or r[i][0] != asof:
                continue
            iv, iv5 = r[i][2], r[i - 5][2]
            if iv and iv > IV_MIN:
                out.append((t, z, iv, r[i][1], (iv - iv5) if iv5 else None, grp.get(t)))
    return asof, out


def detect_shadow(asof: date) -> list[tuple[str, str, dict]]:
    panel = PL.s151_panel(None, rebuild=False)
    out = []
    for sid, meta in SHADOW.items():
        fired = preset_fires(panel, meta["preset"], asof)
        for r in fired.itertuples():
            out.append(
                (
                    sid,
                    r.ticker,
                    {
                        "preset": meta["preset"],
                        "study": PRESETS[meta["preset"]]["study"],
                        "delta": meta["delta"],
                        "exit": meta["exit"],
                        "close": float(r.close),
                        "up_climax": int(getattr(r, "up_climax", 0)),
                    },
                )
            )
    return out


def price_open(conn):
    """Once LSEG has the next session's close: pick the put at strategy delta and record entry mid."""
    opens = conn.execute("SELECT strategy_id, as_of, ticker FROM watchlist_sync.strategy_signals WHERE status = 'open'").fetchall()
    if not opens or P.OP is None:
        return
    P.OP.ensure(conn)
    with P.lseg_session() as ld:
        for sid, asof, t in opens:
            nxt = conn.execute("""SELECT date, close::float, iv30_put::float FROM lseg_research.daily_history
                                  WHERE ticker = %s AND date > %s ORDER BY date LIMIT 1""", (t, asof)).fetchone()
            if not nxt:
                continue
            d, S, iv = nxt
            td = SHADOW.get(sid, {}).get("delta", -0.20)
            got = P.pick_contract(ld, conn, t, d, S, iv, live=True, target_delta=td)
            mid = P.mid_on(got[2], d) if got else None
            if not mid:
                conn.execute("UPDATE watchlist_sync.strategy_signals SET status = 'no_contract' WHERE strategy_id = %s "
                             "AND as_of = %s AND ticker = %s", (sid, asof, t))
                continue
            e, K, _ = got
            conn.execute("""UPDATE watchlist_sync.strategy_signals SET status = 'priced', occ = %s, expiry = %s, strike = %s,
                            entry_mid = %s, entry_date = %s WHERE strategy_id = %s AND as_of = %s AND ticker = %s""",
                         (f"{t} {e:%m/%d/%y} {K:g}P", e, K, mid, d, sid, asof, t))
    conn.commit()


def _grade_row(conn, sid, asof, t, expiry, strike, entry_mid, entry_date, settle_px, exit_mode: str):
    intr = max(0.0, strike - settle_px)
    ret = (entry_mid - intr) / strike
    itm = intr > 0
    if exit_mode == "stop50" and ret <= -0.5:
        pass  # stop hit — still graded at this observation
    conn.execute("""UPDATE watchlist_sync.strategy_signals SET status = 'graded', settle = %s, ret = %s, itm = %s,
                    graded_at = now() WHERE strategy_id = %s AND as_of = %s AND ticker = %s""",
                 (settle_px, ret, itm, sid, asof, t))


def grade(conn):
    for sid, asof, t, e, k, m, ed in conn.execute("""SELECT strategy_id, as_of, ticker, expiry, strike, entry_mid, entry_date
                                                 FROM watchlist_sync.strategy_signals WHERE status = 'priced'""").fetchall():
        exit_mode = "expiry" if sid == "panic-puts-hiv" else SHADOW.get(sid, {}).get("exit", "expiry")
        if exit_mode == "half_dte" and ed and e:
            half = ed + timedelta(days=max(1, (e - ed).days // 2))
            if date.today() < half:
                continue
            grade_day = half
        elif exit_mode == "stop50" and ed and e:
            half = ed + timedelta(days=max(1, (e - ed).days // 2))
            grade_day = min(date.today(), half) if date.today() >= ed + timedelta(days=1) else None
            if grade_day is None:
                continue
            # walk daily closes for stop
            rows = conn.execute("""SELECT date, close::float FROM lseg_research.daily_history
                                   WHERE ticker = %s AND date > %s AND date <= %s ORDER BY date""",
                                (t, ed, e)).fetchall()
            stopped = False
            for d, c in rows:
                intr = max(0.0, k - c)
                if (m - intr) / k <= -0.5:
                    st = conn.execute("SELECT close::float FROM lseg_research.daily_history WHERE ticker = %s AND date <= %s "
                                      "ORDER BY date DESC LIMIT 1", (t, d)).fetchone()
                    if st:
                        _grade_row(conn, sid, asof, t, e, k, m, ed, st[0], exit_mode)
                    stopped = True
                    break
            if stopped:
                continue
            if date.today() < half:
                continue
            grade_day = half
        else:
            if e >= date.today():
                continue
            grade_day = e
        st = conn.execute("SELECT close::float FROM lseg_research.daily_history WHERE ticker = %s AND date <= %s "
                          "ORDER BY date DESC LIMIT 1", (t, grade_day)).fetchone()
        if not st:
            continue
        _grade_row(conn, sid, asof, t, e, k, m, ed, st[0], exit_mode)
    conn.commit()


def main():
    conn = connect()
    conn.execute(DDL)
    asof = next((date.fromisoformat(a.split("=")[1]) for a in sys.argv if a.startswith("--asof=")), None)
    asof, sig = detect(conn, asof)
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO watchlist_sync.strategy_signals (strategy_id, as_of, ticker, trigger, details)
                           VALUES ('panic-puts-hiv', %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                        [(asof, t, f"{t} fell {z:.1f}σ in 5 days; IV {iv:.0f} % (> 49) → sell ~0.20Δ put ~30 DTE",
                          json.dumps({"z": z, "iv30": iv, "close": c, "iv_jump_5d": j, "peer_group": g,
                                      "same_group_today": sum(1 for x in sig if x[5] and x[5] == g)}))
                         for t, z, iv, c, j, g in sig])
        shadow = detect_shadow(asof)
        for sid, t, det in shadow:
            cur.execute(
                """INSERT INTO watchlist_sync.strategy_signals (strategy_id, as_of, ticker, trigger, details)
                   VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                (
                    sid,
                    asof,
                    t,
                    f"S151 up-volume climax + filter → sell ~0.08Δ put next open ({sid})",
                    json.dumps(det),
                ),
            )
    conn.commit()
    price_open(conn)
    grade(conn)
    n = conn.execute("SELECT status, count(*) FROM watchlist_sync.strategy_signals GROUP BY 1").fetchall()
    sh = conn.execute(
        "SELECT strategy_id, count(*) FROM watchlist_sync.strategy_signals WHERE as_of = %s AND strategy_id = ANY(%s) GROUP BY 1",
        (asof, list(SHADOW.keys())),
    ).fetchall()
    print(
        f"strategy signals {asof}: {len(sig)} panic new ({', '.join(t for t, *_ in sig) or 'none'}); "
        f"shadow {dict(sh)}; totals {dict(n)}"
    )


if __name__ == "__main__":
    main()
