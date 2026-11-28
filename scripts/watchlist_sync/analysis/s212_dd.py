#!/usr/bin/env python3
"""S212 deeper due diligence per ranked name (11-27 #10) → out/rr/s212_dd.json. DB only, no vendor calls.

  * earnings: last 8 reports — biggest close-to-close move of the report day or the next session (the calendar has no
    before/after-open flag, so the larger one is taken: the conservative read for a short put), vs the put's cushion.
  * stress: the stock's own worst N-session return (N = sessions to expiry) inside 2020-02→04, 2022-01→10, 2025-02→05,
    applied to today's spot → this exact structure's P&L at expiry per lot. Expiry value only (path / margin not modelled).
  * peers: name vs the median of its Fildi peer group (stage-1 universe, gated names included) on fwd P/E, revenue
    growth, operating margin, FCF yield, ROIC.
  * vs SMH: the same $0 trade on SMH (Δ ratio, skew) — the no-single-name-risk comparator.

    .venv/bin/python analysis/s212_dd.py
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "rr"
STRESS = (("2020 Covid crash", "2020-02-01", "2020-04-30"), ("2022 bear market", "2022-01-01", "2022-10-31"),
          ("2025 tariff crash", "2025-02-01", "2025-05-31"))
PEER_KEYS = ("fwd_pe", "rev_g", "op_mgn", "fcf_yield", "roic")


def main():
    R = json.loads((OUT / "s212_ranked.json").read_text())
    S1 = json.loads((OUT / "s212_stage1.json").read_text())
    groups = defaultdict(list)
    for r in S1["rows"]:
        if r.get("peer"):
            groups[r["peer"]].append(r)
    smh = next((e for e in R["etfs"] if e["ticker"] == "SMH"), None)
    out = {}
    with connect() as conn:
        for r in R["ranked"]:
            t, S, s = r["ticker"], r["spot"], r["s"]
            Kp, Kc, net = s["put"]["strike"], s["call"]["strike"], s["net"]
            h = max(5, round(r["T"] * 252))
            # prices_historical starts 2025-05; LSEG daily history goes back to 2018 (stress windows), merged, newest wins
            m = dict(conn.execute("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker = %s AND close > 0", (t,)).fetchall())
            m.update(conn.execute("SELECT date, close::float8 FROM prices_historical WHERE ticker = %s AND close > 0", (t,)).fetchall())
            px = sorted(m.items())
            ds = [d for d, _ in px]
            c = np.array([v for _, v in px])
            idx = {d: i for i, d in enumerate(ds)}
            # earnings reactions
            er = []
            for (rd,) in conn.execute("""SELECT report_date FROM earnings_calendar WHERE ticker = %s AND report_date < current_date
                                         AND report_date >= current_date - interval '3 years' ORDER BY report_date DESC LIMIT 8""", (t,)):
                i = next((idx[d] for d in ds if d >= rd), None) if rd not in idx else idx[rd]
                if i is None or i < 1 or i + 1 >= len(c):
                    continue
                a, b = c[i] / c[i - 1] - 1, c[i + 1] / c[i] - 1
                er.append({"date": str(rd), "move": float(a if abs(a) > abs(b) else b)})
            cushion = 1 - Kp / S
            # stress replays
            st = []
            for name, lo, hi in STRESS:
                w = [i for i, d in enumerate(ds) if str(lo) <= str(d) <= str(hi)]
                if len(w) < h + 5 or w[0] + h >= len(c):
                    st.append({"window": name, "ret": None})
                    continue
                rets = [c[i + h] / c[i] - 1 for i in w if i + h < len(c) and i + h <= w[-1] + h]
                worst = float(min(rets))
                ST = S * (1 + worst)
                pnl = (max(ST - Kc, 0) - max(Kp - ST, 0) + net) * 100
                st.append({"window": name, "ret": worst, "price": ST, "pnl": pnl,
                           "pnl_vs_assign": pnl / (Kp * 100)})
            # peers
            g = [x for x in groups.get(r["info"].get("peer"), []) if x["ticker"] != t]
            peers = {}
            for k in PEER_KEYS:
                vals = [x.get(k) for x in g if x.get(k) is not None]
                peers[k] = {"me": r["info"].get(k), "median": float(np.median(vals)) if len(vals) >= 3 else None, "n": len(vals)}
            out[t] = {"earnings": er, "cushion": cushion,
                      "er_breach": sum(1 for x in er if x["move"] <= -cushion), "er_big_down": min((x["move"] for x in er), default=None),
                      "er_abs_med": float(np.median([abs(x["move"]) for x in er])) if er else None,
                      "stress": st, "h": h, "peers": peers, "peer_n": len(g)}
    vs = None
    if smh:
        vs = {"delta_ratio": smh["s"]["delta_ratio"], "skew15": smh["skew15"], "put_otm": smh["s"]["put_otm"],
              "call_otm": smh["s"]["call_otm"], "put": smh["s"]["put"]["strike"], "call": smh["s"]["call"]["strike"]}
    (OUT / "s212_dd.json").write_text(json.dumps({"asof": str(date.today()), "smh": vs, "names": out}, default=str))
    print(f"dd: {len(out)} names → {OUT / 's212_dd.json'}")
    for t, d in list(out.items())[:20]:
        sx = " · ".join(f"{x['window'][:4]} {x['ret']:+.0%} → {x['pnl']:+,.0f}" for x in d["stress"] if x.get("ret") is not None)
        print(f"{t:<5} er n {len(d['earnings'])} med |{(d['er_abs_med'] or 0):.0%}| worst {(d['er_big_down'] or 0):+.0%} "
              f"breach {d['er_breach']} (cushion {d['cushion']:.0%}) | {sx}")


if __name__ == "__main__":
    main()
