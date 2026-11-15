#!/usr/bin/env python3
"""S103 check on REAL option quotes: replay the exit rules on LSEG daily bid/ask (optlab.lseg_opt_daily) and compare with
the S103 model marks on the same contracts. Sell = bid + 23 % of the spread, buy back = ask − 23 % (RH fill, state.md);
expiry settles at intrinsic. Entry = first quote day with DTE in the tenor window and BS |Δ| 0.08–0.20 (put).

Per exit rule: mean P&L % of strike, mean days held, P&L per collateral-day, and "lane value" = P&L + days freed × the
hold-to-expiry rate per day (what re-selling the freed cash earns), real vs model.

    .venv/bin/python analysis/s103_real_check.py
"""
from __future__ import annotations

import math
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
import indicators as IND  # noqa: E402
import s103_put_lifecycle as S  # noqa: E402
from build_plan import connect  # noqa: E402
from s076_structures_backtest import Pricer, fill  # noqa: E402

RIC = re.compile(r"^([A-Z.]+?)([A-X])(\d\d)(\d\d)(\d{5})\.U")
WIN = {"1w": (5, 9), "3w": (18, 24)}
OUT = HERE.parent / "out" / "opt" / "S103_real.md"
HOLD: list = []


def bs_put_delta(S_, K, iv, T):
    from quantcore.bs import put_delta as _d  # quantcore.bs — one home (Jamie 11-15)
    return _d(spot=S_, strike=K, iv=iv, years=T)


def main():
    with connect() as conn:
        pr = Pricer(conn)
        q = defaultdict(list)
        for ric, d, b, a in conn.execute("SELECT ric, date, bid::float8, ask::float8 FROM optlab.lseg_opt_daily WHERE bid >= 0 AND ask > 0 ORDER BY ric, date"):
            m = RIC.match(ric)
            if not m or m.group(2) < "M":
                continue
            q[ric].append((d, b, a))
        roots = sorted({RIC.match(r).group(1) for r in q})
        bars = IND.load_bars(conn, roots)
        ivh = defaultdict(dict)
        for t, d, v in conn.execute("SELECT ticker, date, iv30_put::float8 FROM lseg_research.daily_history WHERE iv30_put > 0 AND ticker = ANY(%s)", (roots,)):
            ivh[t][d] = v / 100 if v > 3 else v
    feats = {}
    for t, b in bars.items():
        if len(b[3]) >= 320:
            s = IND.compute(*b)
            feats[t] = ({d: i for i, d in enumerate(b[0])}, s, np.asarray(b[3], float))
    res = defaultdict(lambda: defaultdict(list))
    for ric, rows in q.items():
        root, let, dd, yy, k = RIC.match(ric).groups()
        try:
            exp = date(2000 + int(yy), (ord(let) - ord("A")) % 12 + 1, int(dd))
        except ValueError:
            continue
        if root not in feats:
            continue
        ix, s, c = feats[root]
        K = int(k) / 100
        for ten, (lo, hi) in WIN.items():
            ent = next((r for r in rows if lo <= (exp - r[0]).days <= hi and r[0] in ix and r[1] > 0), None)
            if not ent:
                continue
            i = ix[ent[0]]
            S0, iv0 = c[i], ivh[root].get(ent[0])
            if not iv0 or K / S0 < 0.5 or K >= S0:
                continue
            tot = (exp - ent[0]).days
            dl = -bs_put_delta(S0, K, iv0, tot / 365)
            if not 0.08 <= dl <= 0.20:
                continue
            path = [r for r in rows if ent[0] < r[0] < exp and r[0] in ix]
            jx = max((v for d_, v in ix.items() if d_ <= exp), default=None)
            if jx is None or len(path) < 2 or (exp - path[-1][0]).days > 4:
                continue   # need quotes up to the last days of the contract
            sell_r = ent[1] + 0.23 * (ent[2] - ent[1])
            mid0, spr0 = pr.mid("put", S0, K, iv0, tot, ent[0])
            sell_m = fill(mid0, spr0, -1)
            if sell_r < 0.05:
                continue
            settle = max(K - c[jx], 0.0)
            ks = [ix[r[0]] for r in path]
            buy_r = np.array([max(r[2] - 0.23 * (r[2] - r[1]), 0.0) for r in path])
            buy_m = []
            for r in path:
                ivk = ivh[root].get(r[0], iv0)
                m, sp = pr.mid("put", c[ix[r[0]]], K, ivk, max((exp - r[0]).days, 1), r[0])
                buy_m.append(max(fill(m, sp, +1), S.MIN_BUY, K - c[ix[r[0]]]))
            buy_m = np.array(buy_m)
            el = np.array([(r[0] - ent[0]).days for r in path], float)
            kk = np.array(ks)
            for src, sell, buy in (("real", sell_r, buy_r), ("model", sell_m, buy_m)):
                p = {"cap": (sell - buy) / sell, "el": el, "tot": tot,
                     "ut_dn": (s["ut_dir"][kk] < 0) & (s["ut_dir"][kk - 1] > 0),
                     "cl_dn": (s["stc_bull"][kk] <= 0.4) & (s["stc_bull"][kk - 1] > 0.4),
                     "fg": np.nan_to_num(s["fear_greed"][kk], nan=50), "bdiv": s["rsi_div"][kk] < 0}
                for name, rule in S.EXITS.items():
                    e = rule(p)
                    pnl, days = (sell - settle, tot) if e is None else (sell - buy[e], el[e])
                    res[(ten, src)][name].append((pnl / K, days, tot))
                    if name == "E0 hold" and src == "real":
                        HOLD.append((ten, ent[0], pnl / K, float(s["stc_bull"][i]), float(s["fear_greed"][i]), root, float(iv0)))
                    st = {"cluster ≤ 0.2": s["stc_bull"][i] <= 0.2, "fear ≤ 30": s["fear_greed"][i] <= 30,
                          "greed ≥ 70": s["fear_greed"][i] >= 70, "SMC reclaim": (s["sweep_age"][i] <= 3) and K <= s["sweep_low"][i],
                          "cluster ≥ 0.8": s["stc_bull"][i] >= 0.8}
                    for sk, on in st.items():
                        if on:
                            res[(ten, src, sk)][name].append((pnl / K, days, tot))
    L = [f"# S103 real-quote check ({date.today()})", "",
         "Same contracts, real LSEG bid/ask vs S103 model marks. lane value = P&L + days freed × the hold rate per day (re-sell), % of strike per trade.", "",
         "| tenor | exit | n | real P&L % · days · lane value % | real lane − hold (t) | model P&L % · days · lane value % |", "|---|---|---|---|---|---|"]
    for ten in WIN:
        for name in S.EXITS:
            cells = []
            for src in ("real", "model"):
                x = res[(ten, src)][name]
                h = res[(ten, src)]["E0 hold"]
                rate = np.mean([a for a, _, _ in h]) / np.mean([t for _, _, t in h]) if h else 0
                lv = np.mean([a + (t - d_) * rate for a, d_, t in x]) * 100 if x else float("nan")
                cells.append(f"{np.mean([a for a, _, _ in x]) * 100:+.3f} · {np.mean([d_ for _, d_, _ in x]):.1f} · {lv:+.3f}" if x else "—")
            x, h = res[(ten, "real")][name], res[(ten, "real")]["E0 hold"]
            rate = np.mean([a for a, _, _ in h]) / np.mean([t for _, _, t in h])
            dif = np.array([(a + (t - d_) * rate) - hh[0] for (a, d_, t), hh in zip(x, h)]) * 100
            tt = dif.mean() / (dif.std(ddof=1) / math.sqrt(len(dif))) if dif.std() > 0 else 0.0
            L.append(f"| {ten} | {name} | {len(x)} | {cells[0]} | {dif.mean():+.3f} ({tt:.1f}) | {cells[1]} |")
    L += ["", "## Subsets by entry-day state (real quotes): pace exits vs hold, lane value per trade", "",
          "| tenor | state | n | hold % | pace 3× − hold (t) | pace 4× − hold (t) | pace 5× − hold (t) | 80 % − hold (t) |", "|---|---|---|---|---|---|---|---|"]
    for ten in WIN:
        allh = res[(ten, "real")]["E0 hold"]
        rate = np.mean([a for a, _, _ in allh]) / np.mean([t for _, _, t in allh])
        for sk in ("cluster ≤ 0.2", "fear ≤ 30", "greed ≥ 70", "SMC reclaim", "cluster ≥ 0.8"):
            R_ = res.get((ten, "real", sk))
            if not R_ or len(R_["E0 hold"]) < 30:
                continue
            h = R_["E0 hold"]
            cells = []
            for ex in ("E2 pace 3×", "E2 pace 4×", "E2 pace 5×", "E1 80%"):
                dif = np.array([(a + (t - d_) * rate) - hh[0] for (a, d_, t), hh in zip(R_[ex], h)]) * 100
                tt = dif.mean() / (dif.std(ddof=1) / math.sqrt(len(dif))) if dif.std() > 0 else 0.0
                cells.append(f"{dif.mean():+.3f} ({tt:.1f})")
            L.append(f"| {ten} | {sk} | {len(h)} | {np.mean([a for a, _, _ in h]) * 100:+.3f} | " + " | ".join(cells) + " |")
    L += ["", "## Held to expiry on real quotes, by entry-day state and period (week-clustered t of state − rest)", "",
          "| tenor | state | ≤2022 n · mean % | 2023→ n · mean % | rest ≤2022 / 2023→ | t (≤2022, 2023→) | weeks with the state |", "|---|---|---|---|---|---|---|"]
    from collections import defaultdict as dd_
    for ten in WIN:
        xs = [h for h in HOLD if h[0] == ten]
        for sk, f in (("fear ≤ 30", lambda h: h[4] <= 30), ("fear ≤ 40", lambda h: h[4] <= 40), ("cluster ≤ 0.2", lambda h: h[3] <= 0.2),
                      ("greed ≥ 70", lambda h: h[4] >= 70), ("cluster ≥ 0.8", lambda h: h[3] >= 0.8)):
            cells, ts, rest = [], [], []
            for part in (lambda d: d < date(2023, 1, 1), lambda d: d >= date(2023, 1, 1)):
                a = [h for h in xs if part(h[1]) and f(h)]
                b = [h for h in xs if part(h[1]) and not f(h)]
                cells.append(f"{len(a)} · {np.mean([h[2] for h in a]) * 100:+.3f}" if a else "—")
                rest.append(f"{np.mean([h[2] for h in b]) * 100:+.3f}" if b else "—")
                wa, wb = dd_(list), dd_(list)
                for h in a: wa[h[1].isocalendar()[:2]].append(h[2])
                for h in b: wb[h[1].isocalendar()[:2]].append(h[2])
                dif = np.array([np.mean(wa[k]) - np.mean(wb[k]) for k in wa if k in wb])
                ts.append(f"{dif.mean() / (dif.std(ddof=1) / math.sqrt(len(dif))):.1f}" if len(dif) > 5 and dif.std() > 0 else "—")
            nwk = len({h[1].isocalendar()[:2] for h in xs if f(h)})
            L.append(f"| {ten} | {sk} | {cells[0]} | {cells[1]} | {' / '.join(rest)} | {', '.join(ts)} | {nwk} |")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
