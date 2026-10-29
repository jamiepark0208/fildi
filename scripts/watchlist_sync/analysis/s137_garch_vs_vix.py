"""S137 — Copy/test bashtage/arch (1.6k★): does a GARCH volatility forecast beat trailing RV20 as the
'options too cheap' flag in S130's put-breach read? (Jamie 10-28: use public implementations.)

GJR-GARCH(1,1) with Student-t, fit every January on all prior daily returns, parameters frozen and filtered
through the year → 5-day-ahead vol forecast each close (no look-ahead). Flag = forecast vol > VIX.
Compared with S130's flag (RV20 > VIX) on the same days: 5-day breach of a VIX-sized put, flag on vs off.
SPY QQQ IWM DIA 2001 → 2026, non-overlapping 5-day windows.
"""
from __future__ import annotations
import sys, warnings
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parent))
from s130_daily_regime import load, tstat  # noqa: E402
from arch import arch_model
warnings.filterwarnings("ignore")
OUT = Path(__file__).resolve().parents[1] / "out" / "opt" / "S137.md"


def garch_vol5(ret: pd.Series) -> pd.Series:
    r = 100 * ret.dropna(); out = []
    for yr in range(2001, r.index[-1].year + 1):
        tr = r[r.index.year < yr]; upto = r[r.index.year <= yr]
        if (upto.index.year == yr).sum() == 0: continue
        res = arch_model(tr, p=1, o=1, q=1, dist="t", mean="Constant").fit(disp="off")
        fixed = arch_model(upto, p=1, o=1, q=1, dist="t", mean="Constant").fix(res.params)
        f = fixed.forecast(horizon=5, start=upto.index[upto.index.year == yr][0], reindex=False)
        out.append(np.sqrt(f.variance.sum(axis=1) * 252 / 5))   # annualised % over the next 5 days
    return pd.concat(out)


def main() -> int:
    D = load(sys.argv[1]); vix = D["^VIX"].close
    L = ["# S137 — GARCH forecast vs trailing RV20 as the 'options too cheap' flag", "",
         "5-day breach of a put sized by the ETF's own implied vol (VIX / VXN / VXD); non-overlapping 5-day windows 2001 → 2026; t = on vs off.", "",
         "| ETF | flag | % of time | breach on / off | t (2001–13) | t (2014–26) |", "|---|---|---|---|---|---|"]
    allr = []
    own_iv = {"SPY": "^VIX", "QQQ": "^VXN", "DIA": "^VXD"}   # IWM: no implied index on Yahoo
    for tk in [t for t in own_iv if own_iv[t] in D]:
        vix = D[own_iv[tk]].close
        c = D[tk].close; ret = np.log(c).diff()
        g = garch_vol5(ret)
        rv = ret.rolling(20).std() * np.sqrt(252) * 100
        v = vix.reindex(c.index).ffill()
        K = c * np.exp(-v / 100 * np.sqrt(5 / 252))
        br = (c.shift(-5) < K).astype(float).where(c.shift(-5).notna())
        X = pd.DataFrame({"g": g, "rv": rv, "vix": v, "br": br}).dropna().iloc[::5]
        X["half"] = np.where(X.index.year < 2014, "a", "b"); X["tk"] = tk
        allr.append(X)
        for name, m in [("RV20 > VIX (S130)", X.rv > X.vix), ("GARCH 5d > VIX", X.g > X.vix), ("both", (X.rv > X.vix) & (X.g > X.vix))]:
            on, off = X[m], X[~m]
            ts = [tstat(on[on.half == h].br, off[off.half == h].br) for h in "ab"]
            L.append(f"| {tk} | {name} | {100 * m.mean():.0f} | {100 * on.br.mean():.1f} / {100 * off.br.mean():.1f} | {ts[0]:+.1f} | {ts[1]:+.1f} |")
    A = pd.concat(allr)
    L += ["", "## Pooled", "", "| flag | breach on / off | t (2001–13) | t (2014–26) | rank IC with breach (forecast − VIX) |", "|---|---|---|---|---|"]
    for name, col in [("RV20 > VIX (S130)", "rv"), ("GARCH 5d > VIX", "g")]:
        m = A[col] > A.vix; on, off = A[m], A[~m]
        ts = [tstat(on[on.half == h].br, off[off.half == h].br) for h in "ab"]
        ic = (A[col] - A.vix).corr(A.br, method="spearman")
        L.append(f"| {name} | {100 * on.br.mean():.1f} / {100 * off.br.mean():.1f} | {ts[0]:+.1f} | {ts[1]:+.1f} | {ic:+.3f} |")
    OUT.write_text("\n".join(L) + "\n"); print("\n".join(L)); return 0


if __name__ == "__main__":
    sys.exit(main())
