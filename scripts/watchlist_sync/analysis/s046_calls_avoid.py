"""S046 — call side + Avoid list re-tested on their own outcomes (A170; METHODS 1b; harness = s045_put_retest).

Calls: sell a 5-session covered call at K = S·exp(+1.0·IV·√(5/252)) on each lab Monday; overwrite pnl = (BS call − max(0, S_T − K)) / S
  (what selling the call adds vs just holding). Features = call-lane tech comps (lab_tech.v4_call: names are the put keys but scored
  for calls — oversoldDepth = overbought depth, reversalSignal = exhaustion, trendContext = trend extension), resistance node between S
  and K, plus the S045 put features.
Avoid list: target = left tail, not mean return — crash = S_T < S·exp(−2·IV·√(5/252)) (≥ 2σ IV-implied 5-day drop) and
  mae21_sig = 21-day max adverse excursion ÷ IV-implied 21-day σ. Features = lab proxies for fit-1.4 red flags: StarMine alpha
  (low = bad), IBES drift/breadth (analysts cutting), IBES dispersion, 52w drawdown / dist_ma200 (falling knife), idio_vol, earnings_21.
Same evaluation as S045: weekly cross-sectional rank IC, controls iv_rv / iv30 / earnings_21, halves; bar |t| ≥ 3, same sign both halves.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s046_calls_avoid.py [--write]
"""
from __future__ import annotations

import math
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import s045_put_retest as M  # noqa: E402

OUT = M.HERE / "out" / "opt" / "S046.md"
HOLD = 5


def bs_call(S, K, vol, t):
    return M.bs_put(S, K, vol, t) + S - K  # put-call parity, r = 0


def build(rows, tech, fund, px):
    pos = {t: ({d: i for i, (d, *_r) in enumerate(b)}, b) for t, b in px.items()}
    ev = []
    for t, d, f in rows:
        if t not in pos or not f or not f.get("iv30"):
            continue
        p, bars = pos[t]
        i = p.get(d)
        if i is None or i < M.LOOKBACK + 22 or i + 21 >= len(bars):
            continue
        c = [b[3] for b in bars]
        lo = [b[2] for b in bars]
        S, ST = c[i], c[i + HOLD]
        iv = float(f["iv30"]) / 100
        if not (0.05 < iv < 3.0):
            continue
        tt = HOLD / 252
        Kc = S * math.exp(iv * math.sqrt(tt))
        call_pnl = (bs_call(S, Kc, iv, tt) - max(0.0, ST - Kc)) / S
        crash = 1.0 if ST < S * math.exp(-2 * iv * math.sqrt(tt)) else 0.0
        mae = min(lo[i + 1:i + 22]) / S - 1
        mae_sig = mae / (iv * math.sqrt(21 / 252))
        h_, l_, v_ = [b[1] for b in bars], lo, [b[4] for b in bars]
        nodes = M.volume_nodes(h_, l_, v_, i)
        tv = tech.get((t, d)) or {}
        cv = {}
        # lab_tech keeps v4_call in the same row; tech map holds v2 only → read call comps from the raw row
        ev.append({"t": t, "d": d, "call_pnl": call_pnl, "crash": crash, "mae_sig": mae_sig,
                   "iv_rv": f.get("iv_rv"), "iv30": iv, "earn": f.get("earnings_21") or 0.0,
                   "res_node": 1.0 if any(S < z < Kc for z in nodes) else 0.0,
                   "alpha": f.get("alpha"), "dd_52w": f.get("dd_52w"), "dist_ma200": f.get("dist_ma200"),
                   "idio_vol": f.get("idio_vol"), "mom_12_1": f.get("mom_12_1"), "rev5": f.get("rev5"), "beta": f.get("beta"),
                   **{f"ibes_{k}": (fund.get((t, d)) or {}).get(f"ibes_{k}") for k in ("drift", "drift_3m", "breadth", "disp", "sue")},
                   **cv})
    return ev


def quint_target(ev, feat, target):
    """Mean target in the feature's top vs bottom quintile within each week (binary features: 1 vs 0)."""
    from collections import defaultdict
    by = defaultdict(list)
    for e in ev:
        if e.get(feat) is not None:
            by[e["d"]].append(e)
    binary = all(e[feat] in (0.0, 1.0) for g in by.values() for e in g)
    top, bot = [], []
    for g in by.values():
        if len(g) < 30:
            continue
        if binary:
            top += [e[target] for e in g if e[feat] == 1.0]
            bot += [e[target] for e in g if e[feat] == 0.0]
        else:
            g = sorted(g, key=lambda e: e[feat])
            q = len(g) // 5
            bot += [e[target] for e in g[:q]]
            top += [e[target] for e in g[-q:]]
    return (float(np.mean(top)) if top else float("nan")), (float(np.mean(bot)) if bot else float("nan"))


def attach_call_tech(conn, ev):
    cur = conn.cursor()
    cur.execute("SELECT ticker, as_of, v4_call FROM watchlist_sync.lab_tech")
    m = {(t, d): v for t, d, v in cur.fetchall()}
    for e in ev:
        v = m.get((e["t"], e["d"])) or {}
        comps = v.get("comps") or {}
        e["call_total"] = v.get("total")
        for k, name in (("oversoldDepth", "call_overbought"), ("reversalSignal", "call_exhaustion"), ("trendContext", "call_trend_ext"),
                        ("volumeConfirm", "call_volume"), ("volatilityState", "call_volstate"), ("relativePressure", "call_relpress")):
            e[name] = comps.get(k)


def main():
    conn = M.connect()
    rows, tech, fund, px = M.load(conn)
    ev = build(rows, tech, fund, px)
    attach_call_tech(conn, ev)
    conn.close()
    L = [f"# S046 — call side + Avoid list on their own outcomes\n",
         f"**Date:** {date.today()} · n {len(ev):,} ticker-weeks · {len({e['t'] for e in ev})} tickers · {min(e['d'] for e in ev)} → {max(e['d'] for e in ev)}",
         f"Base: covered-call overwrite pnl {np.mean([e['call_pnl'] for e in ev]) * 1e4:+.1f} bp/wk · crash (≥ 2σ 5d drop) "
         f"{np.mean([e['crash'] for e in ev]) * 100:.1f} % · mean 21d MAE {np.mean([e['mae_sig'] for e in ev]):.2f} σ\n"]

    def table(title, target, feats, note):
        L.extend([f"## {title}\n", note + "\n", "| feature | IC | t | half A / B | top-q / bottom-q |", "|---|---|---|---|---|"])
        res = {}
        for f in feats:
            a = M.fm(ev, f, target)
            if not a:
                continue
            top, bot = quint_target(ev, f, target)
            scale, unit = (1e4, " bp") if target == "call_pnl" else (100, " %") if target == "crash" else (1, " σ")
            res[f] = a
            L.append(f"| {f} | {a['ic']:+.3f} | {a['t']:+.1f} | {a['ic_a']:+.3f} / {a['ic_b']:+.3f} | "
                     f"{top * scale:+.2f}{unit} / {bot * scale:+.2f}{unit} |")
        cands = [f for f, a in res.items() if abs(a["t"]) >= 3 and np.sign(a["ic_a"]) == np.sign(a["ic_b"])]
        L.append(f"\n**Candidates:** {', '.join(cands) or 'none'}\n")
        return cands

    call_feats = ["call_total", "call_overbought", "call_exhaustion", "call_trend_ext", "call_volume", "call_volstate", "call_relpress",
                  "res_node", "rev5", "mom_12_1", "dist_ma200"]
    avoid_feats = ["alpha", "ibes_drift", "ibes_drift_3m", "ibes_breadth", "ibes_disp", "ibes_sue", "dd_52w", "dist_ma200",
                   "idio_vol", "mom_12_1", "rev5", "beta"]
    c1 = table("Calls — overwrite pnl (positive IC = better call to sell)", "call_pnl", call_feats,
               "IC on (premium − payout)/S, controls iv_rv / iv30 / earnings_21 within week.")
    c2 = table("Avoid — crash (positive IC = more ≥ 2σ drops)", "crash", avoid_feats,
               "Left tail at fixed IV distance: does the flag predict blow-ups the option price did not.")
    c3 = table("Avoid — 21d max adverse excursion in σ (positive IC = shallower drawdown)", "mae_sig", avoid_feats,
               "Same controls. Negative IC = deeper drawdowns for high feature values.")
    text = "\n".join(L)
    print(text)
    if "--write" in sys.argv:
        OUT.write_text(text + "\n")


if __name__ == "__main__":
    main()
