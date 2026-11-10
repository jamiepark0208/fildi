"""S173b — which option structure best uses the VIX÷VIX3M un-invert on high-beta names (Jamie 11-09: "what other trade structures").

Same panel as S173 (lseg daily_history, model prices at own iv30 call/put, buy ×1.05 / sell ×0.95). 30 DTE, held to expiry.
Each structure's return is per $ of its own max risk (short put = strike collateral; spreads = width − credit; debit = debit),
so cells compare on equal capital at risk. Lift = signal − the same name's same structure on any day (same half).
Pools: top-beta fifth (S173 pick), all names, SPY. Train < 2023 / test ≥.
"""
from __future__ import annotations

import math
import sys
from bisect import bisect_left
from collections import defaultdict
from datetime import timedelta
from pathlib import Path
from statistics import mean

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_plan import connect  # noqa: E402
from s172_bottom_signals import bs, strike, signals  # noqa: E402
from s173_bottom_per_stock import BUY, SELL, SPLIT, START, features, load, tstat  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "opt" / "S173b.md"
T = 30 / 365
STRUCTS = {
    "short put 0.20Δ": "per $ strike", "short put 0.30Δ": "per $ strike", "short put 0.10Δ": "per $ strike",
    "put spread 0.30/0.15": "per $ risk", "put spread 0.20/0.10": "per $ risk",
    "risk reversal −0.20P/+0.25C": "per $ strike", "long call 0.50Δ": "per $ debit", "call spread 0.50/0.25": "per $ debit",
    "long stock": "per $ stock",
}


def structs(S, Se, ivc, ivp):
    P = lambda d: (k := strike(S, T, ivp, d, call=False), bs(S, k, T, ivp, call=False))  # noqa: E731
    C = lambda d: (k := strike(S, T, ivc, d), bs(S, k, T, ivc))  # noqa: E731
    pin = lambda k: max(k - Se, 0)  # noqa: E731
    cin = lambda k: max(Se - k, 0)  # noqa: E731
    out = {}
    for d in (0.20, 0.30, 0.10):
        k, p = P(d)
        out[f"short put {d:.2f}Δ"] = (p * SELL - pin(k)) / k
    for hi, lo in ((0.30, 0.15), (0.20, 0.10)):
        (k1, p1), (k2, p2) = P(hi), P(lo)
        cr = p1 * SELL - p2 * BUY
        risk = (k1 - k2) - cr
        if risk > 0:
            out[f"put spread {hi:.2f}/{lo:.2f}"] = (cr - (pin(k1) - pin(k2))) / risk
    (kp, pp), (kc, pc) = P(0.20), C(0.25)
    out["risk reversal −0.20P/+0.25C"] = (pp * SELL - pc * BUY + cin(kc) - pin(kp)) / kp
    k5, c5 = C(0.50)
    out["long call 0.50Δ"] = (cin(k5) - c5 * BUY) / (c5 * BUY)
    k25, c25 = C(0.25)
    db = c5 * BUY - c25 * SELL
    if db > 0:
        out["call spread 0.50/0.25"] = (cin(k5) - cin(k25) - db) / db
    out["long stock"] = Se / S - 1
    return out


def panel(px, dates, spy):
    """{(ticker, date): (structs, beta60)} at the signal dates + own any-day mean per (ticker, half, struct)."""
    rows, own = {}, {}
    for t, p in px.items():
        days = sorted(p)
        acc = defaultdict(list)
        sig_i = {}
        for d in dates:
            i = bisect_left(days, d)
            if i < len(days) and (days[i] - d).days <= 3:
                sig_i[i] = d
        for i in range(0, len(days), 3 if t != "SPY" else 1):  # every 3rd day for the any-day control (speed; unbiased)
            sig_i.setdefault(i, None)
        for i, d in sig_i.items():
            S, ivc, ivp = p[days[i]]
            if not (0.05 < ivc < 3) or not ivp:
                continue
            j = bisect_left(days, days[i] + timedelta(days=30))
            if j >= len(days) or (days[j] - days[i]).days > 36:
                continue
            s = structs(S, p[days[j]][0], ivc, ivp)
            for k, v in s.items():
                acc[(days[i] < SPLIT, k)].append(v)
            if d is not None:
                f = features(p, days, i, spy)
                if f:
                    rows[(t, d)] = (s, f["beta60"])
        if sum(len(v) for v in acc.values()) < 500:
            continue
        for k, v in acc.items():
            own[(t,) + k] = mean(v)
    return rows, own


def main() -> int:
    conn = connect()
    ix, px, _ = load(conn)
    spy = px["SPY"]
    U = [d for d in signals(ix)["U"] if d >= START + timedelta(days=380)]
    rows, own = panel(px, U, spy)
    by = defaultdict(list)
    for (t, d), (s, b) in rows.items():
        if (t, d < SPLIT, "long stock") in own:
            by[d].append((t, s, b))
    L = ["# S173b — structure grid at the VIX÷VIX3M un-invert (top-beta names vs all vs SPY)", "",
         "CONTRACT 1-7: missing 1,8 (priced_by=model 100 %, BS at own iv30, buy ×1.05 / sell ×0.95) · n_indep = episodes (< 30 → UNDERPOWERED)", "",
         f"Episodes {len(by)}; any-day control = every 3rd session per name, same half. Return per $ of the structure's own max risk, 30 DTE to expiry.", "",
         "| structure | basis | half | eps | top-beta mean | lift vs own any-day | t (eps) | all names | SPY | worst ep top-beta | worst name | loss % |",
         "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    summary = {}
    for st, basis in STRUCTS.items():
        for h, nm in ((True, "train"), (False, "test")):
            ep_top, ep_lift, ep_all, ep_spy, names = [], [], [], [], []
            for d, rs in by.items():
                if (d < SPLIT) != h or len(rs) < 25:
                    continue
                rs = [r for r in rs if st in r[1]]
                rs.sort(key=lambda r: r[2])
                top = rs[4 * len(rs) // 5:]
                ep_top.append(mean(r[1][st] for r in top))
                ep_lift.append(mean(r[1][st] - own[(r[0], h, st)] for r in top if (r[0], h, st) in own))
                ep_all.append(mean(r[1][st] for r in rs))
                if ("SPY", d) in rows and st in rows[("SPY", d)][0]:
                    ep_spy.append(rows[("SPY", d)][0][st])
                names += [r[1][st] for r in top]
            if not ep_top:
                continue
            summary[(st, nm)] = (mean(ep_top), mean(ep_lift), tstat(ep_lift), min(ep_top))
            L.append(f"| {st} | {basis} | {nm} | {len(ep_top)} | {mean(ep_top):+.1%} | {mean(ep_lift):+.1%} | {tstat(ep_lift):.2f} | "
                     f"{mean(ep_all):+.1%} | {mean(ep_spy) if ep_spy else float('nan'):+.1%} | {min(ep_top):+.1%} | {min(names):+.0%} | "
                     f"{sum(x < 0 for x in names) / len(names):.0%} |")
    ok = [s for s in STRUCTS if all(summary.get((s, h), (0, -1))[1] > 0 and summary.get((s, h), (0, -1))[3] > -0.05 for h in ("train", "test"))]
    L += ["", "## Verdict", "",
          f"n_indep = {len(by)} episodes → UNDERPOWERED for every cell. Structures with lift > 0 in both halves and no top-beta episode worse "
          f"than −5 % of risk: {', '.join(ok) or 'none'}.",
          "Verdict per structure = the table (entry RULE: first close VIX÷VIX3M < 1 after ≥ 2 inverted sessions × hold 30 DTE to expiry × top-beta fifth).",
          "", "Refs: A244 · S172 · S173"]
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
