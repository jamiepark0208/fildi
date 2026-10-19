"""S050 / A183 — sector laggard catch-up, pre-registered in asks/A183.md (one run, no re-tuning).

Group = ticker_registry.primary_peer_group_id (≥ 5 members that day). Event = leave-one-out equal-weight 5-day group
return z ≥ +2 / ≤ −2 vs the group's prior-60-day 5-day σ (one per group per 10 days). Laggard = stock 5d − group 5d
≤ −1.5·σ5(stock) in a rally (≥ +1.5 in a crash). Enter next close; outcome = stock − group return over 5/10/20 days,
signed in the group's direction (catch-up > 0). Baseline = the event's other members. IS ≤ 2023, holdout 2024→.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s050_sector_laggard.py [--write]
"""
from __future__ import annotations

import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

HOLDOUT = date(2024, 1, 1)
HOLDS = (5, 10, 20)
OUT = HERE.parent / "out" / "opt" / "S050.md"
rng = np.random.default_rng(50)
B = 3000


def load(conn):
    grp = dict(conn.execute("SELECT ticker, primary_peer_group_id FROM ticker_registry "
                            "WHERE primary_peer_group_id IS NOT NULL").fetchall())
    rows = conn.execute("""SELECT ticker, date, close::float FROM lseg_research.daily_history
                           WHERE close > 0 AND ticker = ANY(%s) ORDER BY date""", (list(grp) + ["SPY"],)).fetchall()
    dates = sorted({d for _, d, _ in rows})
    ix = {d: i for i, d in enumerate(dates)}
    tick = sorted({t for t, _, _ in rows})
    tx = {t: i for i, t in enumerate(tick)}
    C = np.full((len(tick), len(dates)), np.nan)
    for t, d, c in rows:
        C[tx[t], ix[d]] = c
    earn = defaultdict(set)
    for t, d in conn.execute("SELECT ticker, report_date FROM lseg_research.earnings_moves").fetchall():
        if d in ix:
            earn[t].add(ix[d])
    return grp, dates, tick, tx, C, earn


def run(grp, dates, tick, tx, C, earn):
    r5 = C / np.roll(C, 5, axis=1) - 1
    r5[:, :5] = np.nan
    lr = np.log(C / np.roll(C, 1, axis=1))
    lr[:, :1] = np.nan
    sd1 = np.full_like(C, np.nan)  # prior-60-day daily σ (up to t−1)
    for j in range(61, len(dates)):
        sd1[:, j] = np.nanstd(lr[:, j - 60:j], axis=1, ddof=1)
    spy = C[tx["SPY"]]
    spy_above = np.array([np.nan if j < 199 else float(spy[j] > np.nanmean(spy[j - 199:j + 1])) for j in range(len(dates))])
    members = defaultdict(list)
    for t, g in grp.items():
        if t in tx and t != "SPY":
            members[g].append(tx[t])
    out = []
    for g, m in members.items():
        if len(m) < 5:
            continue
        m = np.array(m)
        R = r5[m]
        n = np.sum(~np.isnan(R), axis=0)
        tot = np.nansum(R, axis=0)
        last = -99
        ew = np.where(n >= 5, tot / np.maximum(n, 1), np.nan)
        for j in range(70, len(dates) - 21):
            if n[j] < 5 or j - last < 10:
                continue
            hist = ew[j - 60:j:5]
            hist = hist[~np.isnan(hist)]
            if len(hist) < 8 or np.std(hist, ddof=1) == 0:
                continue
            z = ew[j] / np.std(hist, ddof=1)
            if abs(z) < 2:
                continue
            last = j
            sign = 1 if z > 0 else -1
            e = j + 1  # enter next close
            for k, i in enumerate(m):
                if np.isnan(R[k, j]) or np.isnan(sd1[i, j]) or np.isnan(C[i, e]):
                    continue
                loo = (tot[j] - R[k, j]) / (n[j] - 1)
                gap = (R[k, j] - loo) / (sd1[i, j] * np.sqrt(5))
                lag = gap <= -1.5 if sign > 0 else gap >= 1.5
                others = [x for x in m if x != i]
                fwd = {}
                for h in HOLDS:
                    if np.isnan(C[i, e + h]):
                        break
                    gr = np.nanmean([C[x, e + h] / C[x, e] - 1 for x in others if not np.isnan(C[x, e]) and not np.isnan(C[x, e + h])])
                    fwd[h] = sign * ((C[i, e + h] / C[i, e] - 1) - gr)
                if len(fwd) < len(HOLDS):
                    continue
                out.append(dict(t=tick[i], g=g, d=dates[j], entry=dates[e], exit=dates[e + 10], sign=sign, z=z, gap=gap,
                                lag=bool(lag), earn=any(j - 4 <= x <= j for x in earn.get(tick[i], ())),
                                spy_up=spy_above[j] == 1.0, fwd=fwd, ev=(g, j)))
    return out


def boot(x, y=None):
    """Mean of x (minus mean of y) and one-sided p ≤ 0, resampling event clusters."""
    cl = defaultdict(lambda: ([], []))
    for r in x:
        cl[r["ev"]][0].append(r["fwd"][10])
    for r in y or []:
        cl[r["ev"]][1].append(r["fwd"][10])
    keys = list(cl)
    if not keys:
        return float("nan"), 1.0

    def stat(ks):
        a = [v for k in ks for v in cl[k][0]]
        if not a:
            return np.nan
        if y is None:
            return np.mean(a)
        b = [v for k in ks for v in cl[k][1]]
        return np.mean(a) - np.mean(b) if b else np.nan

    obs = stat(keys)
    sims = np.array([stat([keys[i] for i in rng.integers(0, len(keys), len(keys))]) for _ in range(B)])
    sims = sims[~np.isnan(sims)]
    return obs, float(np.mean(sims <= 0)) if len(sims) else 1.0


def report(ev):
    L = ["# S050 — sector laggard catch-up (A183)", "",
         f"{len({r['ev'] for r in ev})} group events, {sum(r['lag'] for r in ev)} laggards, {len(ev)} member-events. "
         "Outcome = stock − group return, signed in the group's direction (catch-up > 0).", "",
         "| slice | laggards n | 5d | 10d | 20d | baseline n | 10d | lag − base 10d | p (lag>0) | p (lag>base) |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    res = {}
    sl = [("in-sample", lambda r: r["d"] < HOLDOUT), ("holdout", lambda r: r["d"] >= HOLDOUT),
          ("holdout · rally", lambda r: r["d"] >= HOLDOUT and r["sign"] > 0),
          ("holdout · crash", lambda r: r["d"] >= HOLDOUT and r["sign"] < 0),
          ("holdout · earnings in window", lambda r: r["d"] >= HOLDOUT and r["earn"]),
          ("holdout · no earnings", lambda r: r["d"] >= HOLDOUT and not r["earn"]),
          ("holdout · SPY ≥ 200d", lambda r: r["d"] >= HOLDOUT and r["spy_up"]),
          ("holdout · SPY < 200d", lambda r: r["d"] >= HOLDOUT and not r["spy_up"])]
    for lab, f in sl:
        lg = [r for r in ev if f(r) and r["lag"]]
        bs = [r for r in ev if f(r) and not r["lag"]]
        m = {h: (np.mean([r["fwd"][h] for r in lg]) if lg else np.nan) for h in HOLDS}
        mb = np.mean([r["fwd"][10] for r in bs]) if bs else np.nan
        _, p1 = boot(lg)
        dlt, p2 = boot(lg, bs)
        res[lab] = (m[10], dlt, p1, p2, len(lg))
        L.append(f"| {lab} | {len(lg)} | {m[5]:+.2%} | {m[10]:+.2%} | {m[20]:+.2%} | {len(bs)} | {mb:+.2%} | {dlt:+.2%} | "
                 f"{p1:.3f} | {p2:.3f} |")
    ho, ins = res["holdout"], res["in-sample"]
    ok = ho[0] >= 0.005 and ho[1] > 0 and max(ho[2], ho[3]) < 0.05 and np.sign(ins[0]) == np.sign(ho[0])
    L += ["", f"**Verdict: {'PASS' if ok else 'FAIL'}** — holdout laggard 10d {ho[0]:+.2%} (n {ho[4]}), vs baseline "
              f"{ho[1]:+.2%}, p {ho[2]:.3f} / {ho[3]:.3f}; in-sample {ins[0]:+.2%}. Cuts are descriptive unless Holm "
              "(3 cuts × 2 sides) clears."]
    OUT.write_text("\n".join(L))
    print("\n".join(L[2:]))
    return ok


def publish(conn, ev, ok):
    import strategy_lib as SL
    from datetime import timedelta
    spy = [(d, float(c)) for d, c in conn.execute(
        "SELECT date, close FROM prices_historical WHERE ticker = 'SPY' AND date >= '2026-01-01' ORDER BY date").fetchall()]
    rows = []
    for r in ev:
        if not r["lag"] or r["entry"] < date(2026, 1, 1):
            continue
        cap = 10_000.0
        pnl = r["fwd"][10] * cap
        side = "long" if r["sign"] > 0 else "short"
        rows.append(dict(entry_ts=SL.ts(r["entry"]), exit_ts=SL.ts(r["exit"]), ticker=r["t"], instrument="stock", side=side,
                         option_type=None, strike=None, expiry=None, dte_at_entry=None, qty=1, entry_px=0.0, exit_px=None,
                         capital=cap, pnl=pnl, ret_pct=r["fwd"][10],
                         trigger=(f"{r['g'].split('.')[-1].replace('_', ' ')} group {'rallied' if r['sign'] > 0 else 'crashed'} "
                                  f"{r['z']:+.1f}σ in 5 days; {r['t']} lagged {r['gap']:+.1f}σ"),
                         exit_reason=f"10 trading days; vs group (hedged){' · earnings in window' if r['earn'] else ''}"))
    if not rows:
        return
    s = dict(strategy_id="sector-laggard", version="1", name="Sector laggard catch-up", family="stock-swing",
             instrument="mixed", status="live" if ok else "failed", study_ref="S050",
             summary="When a peer group rallies or crashes ≥ 2σ in 5 days, trade the member that didn't move, hedged with the group.",
             rules_md=("Group = fine peer group (≥ 5 members). Event: group's 5-day equal-weight return ≥ 2σ (rally) or ≤ −2σ "
                       "(crash). Laggard: lagged the group by ≥ 1.5 of its own 5-day σ. Next close: long laggard / short "
                       "group in a rally (reverse in a crash), hold 10 trading days."),
             caveats_md=("- P&L = (stock − group) return × $10k; no costs or borrow.\n- `entry_px` blank: a hedged pair has no "
                         "single price.\n- Tested 2018→ with holdout 2024→ (S050); the page shows 2026 trades."),
             price_source="close", holdout_start=date(2026, 1, 1))
    eq, _ = SL.equity(rows, spy, date(2026, 1, 1), bankroll=10_000.0 * 5)
    SL.write_rows(conn, s, rows, eq)
    conn.commit()


def main(write=False):
    conn = connect()
    ev = run(*load(conn))
    ok = report(ev)
    if write:
        publish(conn, ev, ok)


if __name__ == "__main__":
    main("--write" in sys.argv)
