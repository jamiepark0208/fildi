"""S178 robustness view over ~/.fildi/cache/s178_rows.pkl: per config × entry set — mean, winsorized mean (ALL p99 cap), eras,
same-Δ stock eras, per-name mean, share of names > 0, top-10-name share of P&L, month-block t of lift vs ALL, entry stress ×1.10."""
import math, pickle, statistics as st, sys
from collections import defaultdict
from datetime import date
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from s178_call_grid import SETS, OUTP, SPLIT, month_t  # noqa: E402

rows = pickle.loads(OUTP.read_bytes())
SETS = {**SETS, "IVLOW∧UP": lambda f: f["ivp"] <= 0.2 and f["z50"] > 0, "PANIC∧IVLOW?": lambda f: (f["vixr"] or 0) >= 1 and f["ivp"] <= 0.5}
keys = [(240, 0.30, "h63"), (240, 0.50, "h63"), (240, 0.70, "h63"), (240, 0.30, "h21"), (240, 0.30, "tp"), (120, 0.30, "h63"),
        (120, 0.50, "h63"), (120, 0.70, "h63"), (60, 0.50, "exp"), (60, 0.70, "exp"), (30, 0.50, "exp"), (30, 0.70, "exp"),
        (30, "csp", "exp"), (30, "rr0.50", "exp"), (120, "csp", "h63"), (120, "rr0.30", "h63"), (240, "csp", "h63"), (240, "rr0.30", "h63")]
for k in keys:
    allv = [o[k][0] for f, o in rows if k in o]
    cap = sorted(allv)[int(len(allv) * 0.99)]; am = st.mean(allv)
    for s in ("ALL", "IVLOW", "IVLOW∧UP", "PANIC", "DIP", "RICH"):
        v = [(f, o[k]) for f, o in rows if k in o and SETS[s](f)]
        if len(v) < 100:
            continue
        w = [min(r[0], cap) for _, r in v]
        bn, tot = defaultdict(list), defaultdict(float)
        for f, r in v:
            bn[f["t"]].append(r[0]); tot[f["t"]] += r[0]
        nm = [st.mean(x) for x in bn.values()]
        top = sum(sorted(tot.values(), reverse=True)[:10]); S = sum(tot.values())
        e = [st.mean([min(r[0], cap) for f, r in v if (f["d"] < SPLIT) == a]) for a in (True, False)]
        hs = [r[2] for _, r in v if r[2] is not None]
        se = [st.mean([r[2] for f, r in v if r[2] is not None and (f["d"] < SPLIT) == a] or [math.nan]) for a in (True, False)]
        stress = st.mean((1 + r[0]) / 1.10 - 1 for _, r in v)
        t = month_t([(f["d"], r[0] - am) for f, r in v]) if s != "ALL" else math.nan
        leg = k[1] if isinstance(k[1], str) else f"C{k[1]:.2f}"
        print(f"{k[0]:3d} {leg:6s} {k[2]:3s} {s:9s} n{len(v):6d} mean {100 * st.mean(r[0] for _, r in v):+6.1f} wins {100 * st.mean(w):+6.1f} "
              f"eras {100 * e[0]:+6.1f}/{100 * e[1]:+6.1f} " + (f"Δstk {100 * se[0]:+6.1f}/{100 * se[1]:+6.1f} " if hs else " " * 21) +
              f"names {100 * st.mean(nm):+6.1f} ({100 * sum(x > 0 for x in nm) / len(nm):2.0f}%+) top10 {100 * top / S if S > 0 else math.nan:4.0f}% "
              f"×1.1 {100 * stress:+6.1f} t {t:4.1f}")
    print()
