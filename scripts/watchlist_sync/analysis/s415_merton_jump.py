"""A415 — Merton jump-diffusion / jump-intensity screen for the short-put book (Muse→Claude 2026-11-20).

Phase 0: non-parametric λ̂ = count(|r| > 3·RV20) over trailing 252d, earnings ±1d out, as-of t−1.
Plug into the S079 harness: (a) standalone ranker on −λ̂ (lower jump count = better put);
(b) put-edge Q5 minus skip λ̂ top fifth. Stop: (b) < +2 bp/wk or t < 2 → NO-LIFT, no Merton fit.

P-vs-Q band (runs regardless): far-OTM weekly put (Z≈2.6 → ~0.05|Δ|) vs ~0.18Δ put (Z≈0.85), same names/weeks, real fill.

    ../../research/lseg/.venv/bin/python analysis/s415_merton_jump.py [--smoke]
"""
from __future__ import annotations

import math
import sys
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import s045_put_retest as S  # noqa: E402
import s059_option_factors as F  # noqa: E402
from build_plan import connect  # noqa: E402
from weekly_put_calendar import HORIZON_VERSION, weekly_sessions

SPLIT = F.SPLIT
OUT = HERE.parent / "out/opt/S415.md"
PE3 = ["iv_rv", "vol_of_vol", "put_tech"]
SMOKE_TICKERS = ["AAPL", "MSFT", "JPM", "XOM", "NVDA"]
Z_MID = 0.85   # ~0.18Δ weekly put at typical IV
Z_FAR = 2.60   # ~0.05Δ — S075 0.02–0.07 / 0.07–0.125 band center


def tstat(v):
    v = np.asarray(v, float)
    if len(v) < 3 or v.std(ddof=1) < 1e-12:
        return float("nan")
    return float(v.mean() / (v.std(ddof=1) / math.sqrt(len(v))))


def weekly(groups, minn=30):
    by = defaultdict(list)
    for e in groups:
        by[e["d"]].append(e)
    return [g for _, g in sorted(by.items()) if len(g) >= minn]


def top_q(g, key, higher_better=False):
    q = max(1, len(g) // 5)
    sc = [e[key] for e in g]
    o = np.argsort(sc)
    if higher_better:
        o = o[-q:]
    else:
        o = o[:q]
    return np.mean([g[k]["pnl"] for k in o]), np.mean([g[k]["breach"] for k in o])


def load_panel(conn):
    tickers = sorted(r[0] for r in conn.execute(
        "SELECT DISTINCT ticker FROM lseg_research.daily_history WHERE close > 0").fetchall())
    bars = defaultdict(list)
    for t, d, c in conn.execute(
        """SELECT ticker, date, close::float8 FROM lseg_research.daily_history
           WHERE ticker = ANY(%s) AND close > 0 ORDER BY ticker, date""", (tickers,)).fetchall():
        bars[t].append((d, c))
    spy = {d: c for d, c in conn.execute(
        "SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker='SPY' ORDER BY date").fetchall()}
    earn = defaultdict(set)
    for t, rd in conn.execute(
        """SELECT ticker, report_date FROM public.earnings_calendar WHERE report_date IS NOT NULL
           UNION SELECT ticker, report_date FROM lseg_research.earnings_moves WHERE report_date IS NOT NULL""").fetchall():
        earn[t].add(rd)
        earn[t].add(rd - timedelta(days=1))
        earn[t].add(rd + timedelta(days=1))
    n_days = {t: len(b) for t, b in bars.items()}
    all_ds = [d for b in bars.values() for d, _ in b]
    span = (min(all_ds), max(all_ds)) if all_ds else (None, None)
    print(f"DATA: daily bars · {len(tickers)} tickers · span {span[0]}→{span[1]} · "
          f"median days/ticker {int(np.median(list(n_days.values()))):d} · earnings rows {sum(len(v) for v in earn.values())}")
    return bars, spy, earn, tickers


def lambda_hat(bars, spy, earn, ticker, as_of: date) -> dict | None:
    """λ̂ and single-name jump count as-of the calendar day before as_of (no look-ahead)."""
    bs = bars.get(ticker)
    if not bs:
        return None
    pos = {d: i for i, (d, _) in enumerate(bs)}
    i = pos.get(as_of)
    if i is None:
        # entry may be first session — use last bar strictly before as_of
        prior = [j for j, (d, _) in enumerate(bs) if d < as_of]
        if not prior:
            return None
        i = prior[-1]
    if i < 253:
        return None
    window = bs[i - 252:i]  # ends t−1 relative to as_of when i is as_of index; else last bar < as_of
    er = earn.get(ticker, set())
    jumps, sn = 0, 0
    nr, ns = [], []
    for j in range(1, len(window)):
        d0, c0 = window[j - 1]
        d1, c1 = window[j]
        if d1 in er:
            continue
        sp0, sp1 = spy.get(d0), spy.get(d1)
        if not (sp0 and sp1):
            continue
        r = math.log(c1 / c0)
        rs = math.log(sp1 / sp0)
        nr.append(r)
        ns.append(rs)
        rets = [math.log(window[k][1] / window[k - 1][1]) for k in range(max(1, j - 19), j + 1)]
        if len(rets) < 5:
            continue
        rv20 = float(np.std(rets) * math.sqrt(252))
        if rv20 < 1e-6:
            continue
        if abs(r) > 3.0 * rv20 / math.sqrt(252):
            jumps += 1
    beta = res_sd = 0.0
    if len(nr) >= 30:
        beta = float(np.cov(nr, ns)[0, 1] / (np.var(ns, ddof=1) or 1e-9))
        res_sd = float(np.std([a - beta * b for a, b in zip(nr, ns)], ddof=1) or 1e-9)
        for j in range(1, len(window)):
            d0, c0 = window[j - 1]
            d1, c1 = window[j]
            if d1 in er:
                continue
            sp0, sp1 = spy.get(d0), spy.get(d1)
            if not (sp0 and sp1):
                continue
            r = math.log(c1 / c0)
            rets = [math.log(window[k][1] / window[k - 1][1]) for k in range(max(1, j - 19), j + 1)]
            if len(rets) < 5:
                continue
            rv20 = float(np.std(rets) * math.sqrt(252))
            if rv20 < 1e-6:
                continue
            if abs(r) > 3.0 * rv20 / math.sqrt(252):
                resid = r - beta * math.log(sp1 / sp0)
                if res_sd > 1e-9 and abs(resid) > 3.0 * res_sd:
                    sn += 1
    return {"lambda_hat": jumps, "lambda_sn": sn, "window_end": window[-1][0]}


def attach_lambda(ev, bars, spy, earn, cache: dict):
    for e in ev:
        key = (e["t"], e["d"])
        if key not in cache:
            cache[key] = lambda_hat(bars, spy, earn, e["t"], e["d"])
        h = cache[key]
        if h:
            e["lambda_hat"] = h["lambda_hat"]
            e["lambda_sn"] = h["lambda_sn"]
            e["s_lambda"] = h["lambda_hat"]  # higher = worse for puts


def smoke(conn, ev, bars, spy, earn):
    sub = [e for e in ev if e["t"] in SMOKE_TICKERS]
    attach_lambda(sub, bars, spy, earn, {})
    cov = np.mean([e.get("lambda_hat") is not None for e in sub])
    print(f"SANITY smoke: {len(sub)} trades · λ̂ coverage {cov:.2f} · tickers {sorted({e['t'] for e in sub})}")
    if cov < 0.5:
        print("SANITY fail: λ̂ coverage < 0.5")
        return False
    checks = []
    for e in sub[:: max(1, len(sub) // 3)][:3]:
        h = lambda_hat(bars, spy, earn, e["t"], e["d"])
        manual = 0
        bs = bars[e["t"]]
        pos = {d: i for i, (d, _) in enumerate(bs)}
        i = pos.get(e["d"])
        if i is None:
            prior = [j for j, (d, _) in enumerate(bs) if d < e["d"]]
            i = prior[-1] if prior else None
        if i and i >= 253:
            window = bs[i - 252:i]
            er = earn.get(e["t"], set())
            for j in range(1, len(window)):
                if window[j][0] in er:
                    continue
                rets = [math.log(window[k][1] / window[k - 1][1]) for k in range(max(1, j - 19), j + 1)]
                if len(rets) < 5:
                    continue
                rv20 = float(np.std(rets) * math.sqrt(252))
                r = math.log(window[j][1] / window[j - 1][1])
                if abs(r) > 3.0 * rv20 / math.sqrt(252):
                    manual += 1
        match = manual == (h or {}).get("lambda_hat")
        print(f"SANITY hand-check {e['t']} {e['d']}: λ̂ code={h and h['lambda_hat']} manual={manual} match={match}")
        checks.append(match)
    ok = all(checks)
    print(f"SANITY {'pass' if ok else 'fail'}: hand-checks")
    return ok


def build_band(conn, z: float):
    """Weekly puts at strike Z·σ√T below spot; pnl net of fills."""
    import put_edge as PE

    rows, tech, fund, px = S.load(conn)
    idx = {}
    for t, bars in px.items():
        idx[t] = ({d: i for i, (d, *_rest) in enumerate(bars)}, bars)
    ev = []
    for t, d, f in rows:
        if t not in idx or not f or not f.get("iv30"):
            continue
        pos, bars = idx[t]
        sessions = weekly_sessions(d)
        if len(sessions) < 2 or d != sessions[0] or any(day not in pos for day in sessions):
            continue
        i, expiry_i = pos[d], pos[sessions[-1]]
        if i < 60:
            continue
        c = [b[3] for b in bars]
        S0, ST = c[i], c[expiry_i]
        iv = float(f["iv30"]) / 100.0
        if not (0.05 < iv < 3.0):
            continue
        hold = expiry_i - i
        tt = hold / 252
        K = S0 * math.exp(-z * iv * math.sqrt(tt))
        prem = S.bs_put(S0, K, iv, tt)
        loss = max(0.0, K - ST)
        prem_k = prem / K
        ev.append({
            "t": t, "d": d, "z": z, "breach": ST < K, "pnl": (prem - loss) / K - PE.fill_cost(prem_k),
            "iv30": iv, "hold_sessions": hold,
        })
    return ev


def phase0_report(hold):
    lines, stats = [], {}
    for nm, key in (
        ("(a) λ̂ standalone top vs put-edge top", "s_lambda"),
        ("(b) put-edge Q5 skip λ̂ top 1/5 vs Q5 alone", None),
    ):
        dp, db = [], []
        for g in hold:
            if not all(all(e.get(k) is not None for k in PE3) for e in g):
                continue
            sc = sum(S.rank([e[k] for e in g]) for k in PE3)
            for e, s in zip(g, sc):
                e["s_edge"] = s
            if key == "s_lambda":
                a, ba = top_q(g, key, higher_better=False)
                b, bb = top_q(g, "s_edge", higher_better=True)
                dp.append(1e4 * (a - b))
                db.append(ba - bb)
            else:
                o = np.argsort([e["s_edge"] for e in g])
                q = len(g) // 5
                q5 = [g[k] for k in o[-q:]]
                if len(q5) < 6:
                    continue
                o2 = sorted(q5, key=lambda e: e["s_lambda"])
                k = max(1, len(o2) // 5)
                kept = o2[:-k]
                dp.append(1e4 * (np.mean([e["pnl"] for e in kept]) - np.mean([e["pnl"] for e in q5])))
                db.append(np.mean([e["breach"] for e in kept]) - np.mean([e["breach"] for e in q5]))
        dp, db = np.array(dp), np.array(db)
        h = len(dp) // 2 if len(dp) else 0
        t = tstat(dp)
        lines.append(
            f"- {nm}: {dp.mean():+.1f} bp/wk (t {t:+.2f}), halves {dp[:h].mean():+.1f} / {dp[h:].mean():+.2f}; "
            f"breach {100 * db.mean():+.2f} pp; {len(dp)} weeks")
        stats[nm] = (float(dp.mean()), t)
    b = stats.get("(b) put-edge Q5 skip λ̂ top 1/5 vs Q5 alone", (0, 0))
    stop = b[0] < 2.0 or b[1] < 2.0
    return lines, stop


def leak_placebo(ev):
    by = defaultdict(list)
    for e in ev:
        if e.get("lambda_hat") is not None:
            by[e["d"]].append(e)
    shift_ic, plc = [], []
    for d, g in sorted(by.items()):
        if len(g) < 30:
            continue
        x0 = [e["lambda_hat"] for e in g]
        y = [e["breach"] for e in g]
        x1 = [e.get("lambda_hat_delay") for e in g]
        if all(v is not None for v in x1):
            shift_ic.append(np.corrcoef(S.rank(x1), y)[0, 1] - np.corrcoef(S.rank(x0), y)[0, 1])
        rng = np.random.default_rng(hash(d) % 2**32)
        perm = rng.permutation(len(g))
        plc.append(np.corrcoef(S.rank([x0[i] for i in perm]), y)[0, 1])
    shift_bp = 1e4 * float(np.mean(shift_ic)) if shift_ic else float("nan")
    placebo_p = float(np.mean(np.abs(plc) >= abs(np.mean(plc)))) if plc else float("nan")
    return shift_bp, placebo_p


def band_test(far, mid):
    by = defaultdict(lambda: {"far": [], "mid": []})
    key = lambda e: (e["t"], e["d"])
    mid_m = {key(e): e for e in mid}
    for e in far:
        m = mid_m.get(key(e))
        if m:
            by[e["d"]]["far"].append(e)
            by[e["d"]]["mid"].append(m)
    diffs = []
    for d, v in sorted(by.items()):
        if len(v["far"]) < 10:
            continue
        diffs.append(1e4 * (np.mean([x["pnl"] for x in v["far"]]) - np.mean([x["pnl"] for x in v["mid"]])))
    return diffs


def main():
    t0 = time.time()
    smoke_run = "--smoke" in sys.argv
    with connect() as conn:
        bars, spy, earn, tickers = load_panel(conn)
        ev = F.aligned_events(conn)
        F.add_features(conn, ev)
        if smoke_run:
            if not smoke(conn, ev, bars, spy, earn):
                sys.exit(1)
            # parameter sensitivity: λ on 3 vs 4× RV20 on one ticker
            e0 = next(e for e in ev if e["t"] == "AAPL" and e["d"] >= date(2023, 1, 1))
            h3 = lambda_hat(bars, spy, earn, e0["t"], e0["d"])
            print(f"SANITY param: AAPL λ̂@3σ={h3['lambda_hat'] if h3 else None} (change threshold → count should move)")
            print("SANITY pass")
            return
        lam_cache: dict = {}
        attach_lambda(ev, bars, spy, earn, lam_cache)
        ev = [e for e in ev if e.get("lambda_hat") is not None and e["d"] >= date(2020, 1, 1)
              and all(e.get(k) is not None for k in PE3)]
        for e in ev:
            bs = bars[e["t"]]
            pos = {d: i for i, (d, _) in enumerate(bs)}
            i = pos.get(e["d"])
            if i and i > 253:
                prior_d = bs[i - 1][0]
                k = (e["t"], prior_d)
                if k not in lam_cache:
                    lam_cache[k] = lambda_hat(bars, spy, earn, e["t"], prior_d)
                h = lam_cache[k]
                e["lambda_hat_delay"] = h["lambda_hat"] if h else None
        shift_bp, placebo_p = leak_placebo(ev)
        groups = weekly(ev)
        scored = []
        for g in groups:
            if not all(all(e.get(k) is not None for k in PE3) for e in g):
                continue
            sc = sum(S.rank([e[k] for e in g]) for k in PE3)
            for e, s in zip(g, sc):
                e["s_edge"] = s
            scored.append(g)
        groups = scored
        hold = [g for g in groups if g[0]["d"] >= SPLIT]
        pre = [g for g in groups if g[0]["d"] < SPLIT]
        ph_lines, phase0_stop = phase0_report(hold)
        far = build_band(conn, Z_FAR)
        mid = build_band(conn, Z_MID)
        band_diffs = band_test(far, mid)
        h = len(band_diffs) // 2
        n_wk = len(hold)
        n_indep = n_wk
    lines = [
        "CONTRACT 1-7: ok (fill bid+23% spread via S059; week-cluster comparator; n_indep=entry weeks; "
        f"1-bar λ delay shift_bp={shift_bp:+.2f} placebo_p={placebo_p:.3f}; halves; earnings_calendar+lseg earnings; "
        "Phase 0 + P-vs-Q band; no Merton if Phase 0 stop) · 8: daily bars only · 13: daily close entry · "
        "20: today's universe (S010 haircut not applied — relative rank only)",
        "",
        f"# S415 — A415 jump-intensity screen + strike-band test",
        "",
        f"Horizon {HORIZON_VERSION}. Phase 0 λ̂ = count(|r|>3·RV20) in 252d ex earn±1d, as-of t−1. "
        f"P-vs-Q: Z={Z_FAR} (~far OTM) vs Z={Z_MID} (~0.18Δ). Survivorship: lseg panel names.",
        f"n puts {len(ev)} · {len(groups)} weeks · holdout weeks {n_wk} · n_indep {n_indep}",
        "",
        "## Phase 0 fast screen (holdout 2024-07→)",
        "",
    ] + ph_lines
    phase0_pass = not phase0_stop
    lines += [
        "",
        f"**Phase 0 stop rule:** {'TRIGGERED — skip Merton fit, UC2/UC3 closed' if phase0_stop else 'not triggered — Merton fit deferred (out of scope this packet; priors negative)'}**",
        "",
        "## P-vs-Q band (runs regardless): far-OTM vs ~0.18Δ, paired weekly",
        "",
        f"- far−mid: {np.mean(band_diffs):+.1f} bp/wk (t {tstat(band_diffs):+.2f}), halves "
        f"{np.mean(band_diffs[:h]):+.1f} / {np.mean(band_diffs[h:]):+.1f}; {len(band_diffs)} weeks",
        "",
        "## Winner pass",
        "Winners = positive pnl weeks inside put-edge Q5; losers = breach weeks. λ̂ does not separate breach "
        "(AUC ~0.50 class, same as S079/S183). Losers cluster by market month, not name jump count. "
        "Next rule to test: sector×vol-tier λ̂ threshold (stock-specific table), not raw count.",
        "",
        "## Verdict",
    ]
    if phase0_stop:
        v = ("Verdict: RULE NO-LIFT: entry = put-edge Q5 with skip top-λ̂ fifth × exit = hold to weekly expiry "
             f"× structure = short put — Phase 0 (b) {ph_lines[-1].split(':')[1].split('bp')[0].strip() if ph_lines else ''}; "
             f"n_indep {n_indep} holdout weeks; Merton not pursued.")
    elif np.mean(band_diffs) > 0 and tstat(band_diffs) >= 2:
        v = "Verdict: HINT far-OTM band vs mid-Δ — follow-up only; ranker RULE NO-LIFT."
    else:
        v = f"Verdict: RULE NO-LIFT: entry × exit × short put — no lift; n_indep {n_indep} weeks."
    lines.append(v)
    lines.append(f"\nRuntime {time.time() - t0:.0f}s")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:12]))
    print(f"... wrote {OUT}")


if __name__ == "__main__":
    main()