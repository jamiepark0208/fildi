"""S136 — Public regime models, copied and tested on Fildi's harness (Jamie 10-28: "these problems are solved in public repos").

Models (walk-forward: refit every January on all data before it, label the next year online — no look-ahead):
  JM     Statistical jump model, Yizhan-Oliver-Shu/jump-models (Shu & Mulvey 2024; Aydınhan et al. 2024).
         Features exactly as the repo's examples/nasdaq/feature.py: EWM return, log EWM downside deviation and
         Sortino at half-lives 5/20/60; clip ±3σ + standardise on the training window; jump_penalty 50; predict_online.
  HMM    2-state Gaussian HMM (hmmlearn) on the same features — the most common public approach; states are
         FORWARD-FILTERED (hmmlearn's predict() smooths with future data, which would be look-ahead).
  MKV    jackson-video-resources/markov-hedge-fund-method: 20-day return ±5 % → Bull/Bear/Sideways, 3×3 transition
         matrix (MLE on the training window), signal = P(bull) − P(bear) five steps ahead.
  MA200  close > 200-day average (the free baseline).
Judged the way the papers judge (risk-off → cash next day): CAGR, vol, Sharpe, max drawdown vs buy-and-hold, plus
Fildi's put view: next-5-day return and VIX-sized put breach in bull vs bear states (Newey-West t, lag 5).
SPY QQQ IWM DIA, Yahoo daily 1993 → 2026; out-of-sample 2001 → 2026.
"""
from __future__ import annotations

import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s130_daily_regime import load  # noqa: E402

warnings.filterwarnings("ignore")
OUT = Path(__file__).resolve().parents[1] / "out" / "opt" / "S136.md"
TEST_FROM = 2001


def features(ret: pd.Series) -> pd.DataFrame:
    f = {}
    for hl in (5, 20, 60):
        r = ret.ewm(halflife=hl).mean()
        dd = np.sqrt(np.minimum(ret, 0).pow(2).ewm(halflife=hl).mean())
        f[f"ret_{hl}"], f[f"dd_{hl}"], f[f"sortino_{hl}"] = r, np.log(dd), r / dd
    return pd.DataFrame(f).replace([np.inf, -np.inf], np.nan).dropna()


def prep(tr: pd.DataFrame, te: pd.DataFrame):
    mu, sd = tr.mean(), tr.std()
    clip = lambda x: x.clip(mu - 3 * sd, mu + 3 * sd, axis=1)
    trc = clip(tr); m2, s2 = trc.mean(), trc.std()
    return (trc - m2) / s2, (clip(te) - m2) / s2


def jm_states(X: pd.DataFrame, ret: pd.Series) -> pd.Series:
    from jumpmodels.jump import JumpModel
    out = []
    for yr in range(TEST_FROM, X.index[-1].year + 1):
        tr, te = X[X.index.year < yr], X[X.index.year == yr]
        if len(te) == 0: continue
        a, b = prep(tr, te)
        # online labels need the history before the test year too (the DP runs forward)
        full = pd.concat([a, b])
        jm = JumpModel(n_components=2, jump_penalty=50.0, cont=False)
        jm.fit(a, ret.reindex(a.index), sort_by="cumret")
        lab = pd.Series(np.asarray(jm.predict_online(full)), full.index)
        out.append(lab.loc[te.index])
    return pd.concat(out)  # 0 = bull, 1 = bear (sorted by cumulative return)


def hmm_states(X: pd.DataFrame, ret: pd.Series) -> pd.Series:
    from hmmlearn.hmm import GaussianHMM
    from scipy.stats import multivariate_normal as mvn
    out = []
    for yr in range(TEST_FROM, X.index[-1].year + 1):
        tr, te = X[X.index.year < yr], X[X.index.year == yr]
        if len(te) == 0: continue
        a, b = prep(tr, te)
        m = GaussianHMM(n_components=2, covariance_type="full", n_iter=200, random_state=0).fit(a.values)
        # bull = state with the higher mean next-day return in training
        st_tr = m.predict(a.values)
        r1 = ret.reindex(a.index).shift(-1)
        bull = int(np.nanargmax([r1[st_tr == k].mean() for k in range(2)]))
        full = pd.concat([a, b]).values
        ll = np.column_stack([mvn(m.means_[k], m.covars_[k], allow_singular=True).logpdf(full) for k in range(2)])
        alpha = np.log(m.startprob_ + 1e-12) + ll[0]
        filt = np.empty(len(full), int); filt[0] = alpha.argmax()
        lt = np.log(m.transmat_ + 1e-12)
        for i in range(1, len(full)):
            alpha = ll[i] + np.logaddexp.reduce(alpha[:, None] + lt, axis=0)
            alpha -= np.logaddexp.reduce(alpha); filt[i] = alpha.argmax()
        lab = pd.Series(np.where(filt == bull, 0, 1), pd.concat([a, b]).index)
        out.append(lab.loc[te.index])
    return pd.concat(out)


def markov_signal(close: pd.Series) -> pd.Series:
    r20 = close / close.shift(20) - 1
    lab = pd.Series(np.select([r20 > .05, r20 < -.05], [0, 2], 1), close.index).where(r20.notna())
    out = []
    for yr in range(TEST_FROM, close.index[-1].year + 1):
        tr = lab[(lab.index.year < yr)].dropna().astype(int)
        T = np.zeros((3, 3))
        for a, b in zip(tr.values[:-1], tr.values[1:]): T[a, b] += 1
        T = T / T.sum(1, keepdims=True)
        T5 = np.linalg.matrix_power(T, 5)
        te = lab[lab.index.year == yr].dropna().astype(int)
        out.append(pd.Series(T5[te.values, 0] - T5[te.values, 2], te.index))
    s = pd.concat(out)
    return pd.Series(np.where(s > 0, 0, 1), s.index)  # bull if P(bull) > P(bear)


def nw_t(x: pd.Series, lag: int = 5) -> float:
    x = x.dropna().values - x.dropna().values.mean()
    n = len(x); g0 = (x @ x) / n
    v = g0 + 2 * sum((1 - k / (lag + 1)) * (x[k:] @ x[:-k]) / n for k in range(1, lag + 1))
    return np.nan if v <= 0 else 0.0  # placeholder (diff t computed below)


def diff_t(on: pd.Series, off: pd.Series, lag: int = 5) -> float:
    """Difference of means with Newey-West variance on each leg (overlapping daily windows)."""
    def var_mean(x):
        x = x.dropna().values; n = len(x); d = x - x.mean(); g0 = d @ d / n
        v = g0 + 2 * sum((1 - k / (lag + 1)) * (d[k:] @ d[:-k]) / n for k in range(1, lag + 1))
        return v / n
    return (on.mean() - off.mean()) / np.sqrt(var_mean(on) + var_mean(off))


def perf(r: pd.Series) -> tuple[float, float, float, float]:
    cagr = (1 + r).prod() ** (252 / len(r)) - 1
    vol = r.std() * np.sqrt(252)
    eq = (1 + r).cumprod(); mdd = (eq / eq.cummax() - 1).min()
    return cagr, vol, (r.mean() * 252) / vol if vol else np.nan, mdd


def main() -> int:
    D = load(sys.argv[1]); vix = D["^VIX"].close
    L = ["# S136 — Public regime models (jump model, HMM, Markov transition) on Fildi's harness", "",
         f"Walk-forward yearly refit, out of sample {TEST_FROM} → 2026. Risk-off = cash the next day (no costs). "
         "Put view: next-5-day return and breach of a VIX-sized 5-day put, bull vs bear state (NW t, lag 5).", ""]
    pooled = []
    for tk in ["SPY", "QQQ", "IWM", "DIA"]:
        c = D[tk].close; ret = c.pct_change().dropna()
        X = features(ret)
        S = {"JM (jump model)": jm_states(X, ret), "HMM (filtered)": hmm_states(X, ret), "Markov 20d ±5%": markov_signal(c),
             "MA200": pd.Series(np.where(c > c.rolling(200).mean(), 0, 1), c.index)[c.rolling(200).mean().notna()]}
        idx = S["JM (jump model)"].index
        nxt = ret.shift(-1).reindex(idx)
        f5 = (c.shift(-5) / c - 1).reindex(idx)
        K = c * np.exp(-vix.reindex(c.index).ffill() / 100 * np.sqrt(5 / 252))
        br = (c.shift(-5) < K).astype(float).where(c.shift(-5).notna()).reindex(idx)
        L += [f"## {tk}", "", "| model | % days bull | CAGR | vol | Sharpe | max DD | 5d ret bull / bear % | t | 5d breach bull / bear % | t | regime switches / yr |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
        bh = perf(nxt.dropna())
        L.append(f"| buy & hold | 100 | {100 * bh[0]:.1f} % | {100 * bh[1]:.1f} % | {bh[2]:.2f} | {100 * bh[3]:.0f} % | | | | | |")
        for name, s in S.items():
            s = s.reindex(idx)
            strat = (nxt * (s == 0)).dropna()
            p = perf(strat)
            on, off = f5[s == 0], f5[s == 1]
            bon, boff = br[s == 0], br[s == 1]
            sw = (s.diff().abs() > 0).sum() / (len(s) / 252)
            L.append(f"| {name} | {100 * (s == 0).mean():.0f} | {100 * p[0]:.1f} % | {100 * p[1]:.1f} % | {p[2]:.2f} | {100 * p[3]:.0f} % | "
                     f"{100 * on.mean():+.2f} / {100 * off.mean():+.2f} | {diff_t(on, off):+.1f} | {100 * bon.mean():.1f} / {100 * boff.mean():.1f} | {diff_t(bon, boff):+.1f} | {sw:.1f} |")
            pooled.append(dict(tk=tk, model=name, sharpe=p[2], bh_sharpe=bh[2], mdd=p[3], bh_mdd=bh[3],
                               d5=on.mean() - off.mean(), dbreach=bon.mean() - boff.mean()))
        L.append("")
    P = pd.DataFrame(pooled)
    L += ["## Across the 4 ETFs", "", "| model | Sharpe − B&H (mean) | max DD − B&H (mean, pp) | 5d ret bull − bear (pp) | breach bull − bear (pp) |", "|---|---|---|---|---|"]
    for m, g in P.groupby("model", sort=False):
        L.append(f"| {m} | {(g.sharpe - g.bh_sharpe).mean():+.2f} | {100 * (g.mdd - g.bh_mdd).mean():+.0f} | {100 * g.d5.mean():+.2f} | {100 * g.dbreach.mean():+.1f} |")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
