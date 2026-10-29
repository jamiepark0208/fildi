"""S139 — Event-driven vs clock-driven intraday regime (Jamie 10-28: "a reversal can occur at any time — be driven by
technical metrics, not time triggers").

Q1  Freshness: is the S126 rest-of-day risk score computed on EVERY 5-min bar a better forecast than the value from the
    last fixed Live checkpoint (what the tab shows between checkpoints)? Graded at every bar 30–330 min: AUC for a
    further drop ≥ 0.5 ATR before the close, fresh vs stale, by half.
Q2  Events: do technical triggers mark real regime changes? After each event, compare vs a placebo (random bars, same
    count per day, same minute window): P(further drop ≥ 0.5 ATR), rest-of-day range, and direction to the close.
    Events: BOCPD changepoint (Adams & MacKay 2007; Gaussian, unknown mean/var, hazard 1/40 bars), two-sided CUSUM on
    ATR-scaled returns (Page 1954; k = 0.5, h = 4), risk-level jump to 'stormy' (S126 score crosses p80), VWAP cross after
    a ≥ 0.5-ATR excursion (failed-trend reversal).
SPY + QQQ optlab.bars_5m RTH, 2024-11 → 2026-10, H1 < 2025-11-10 ≤ H2, day-clustered t.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
from scipy.special import gammaln

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s126_intraday_regime import load  # noqa: E402
from s130_daily_regime import auc_score  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "opt" / "S139.md"
M = json.loads((Path(__file__).resolve().parents[1] / "out" / "opt" / "S126_model.json").read_text())
CPS = [30, 45, 60, 90, 120, 150, 180, 210, 270, 330]
_mins = np.array(sorted(int(k) for k in M["rngMedianByMin"])); _meds = np.array([M["rngMedianByMin"][str(k)] for k in _mins])


def risk_score(b: pd.DataFrame, m: int, atr: float, ret5: float) -> float:
    o, last = b.o.iloc[0], b.c.iloc[-1]
    hh, ll = b.h.max(), b.l.min()
    path = abs(b.c.iloc[0] - o) + b.c.diff().abs().sum()
    er = abs(last - o) / path if path > 0 else 0
    pc = b.c.shift()
    tr = np.maximum(b.h - b.l, np.maximum((b.h - pc).abs(), (b.l - pc).abs())).fillna(b.h - b.l)
    chop = 100 * np.log10(tr.sum() / (hh - ll)) / np.log10(len(b)) if hh > ll else 100
    rng_rel = (hh - ll) / o / atr / np.interp(m, _mins, _meds)
    x = {"rng_rel": rng_rel, "ret5d": ret5, "er": er, "chop": chop}
    return M["weights"][0] + sum(M["weights"][i + 1] * (x[k] - M["mu"][k]) / M["sd"][k] for i, k in enumerate(M["features"]))


def bocpd(x: np.ndarray, hazard=1 / 40, mu0=0.0, kappa0=1.0, alpha0=1.0, beta0=1.0) -> np.ndarray:
    """P(run length = 0) after each observation — the changepoint probability (Student-t predictive)."""
    T = len(x); R = np.array([1.0]); mu, ka, al, be = np.array([mu0]), np.array([kappa0]), np.array([alpha0]), np.array([beta0])
    cp = np.zeros(T)
    for t in range(T):
        df = 2 * al; scale = np.sqrt(be * (ka + 1) / (al * ka))
        z = (x[t] - mu) / scale
        lp = gammaln((df + 1) / 2) - gammaln(df / 2) - 0.5 * np.log(np.pi * df) - np.log(scale) - (df + 1) / 2 * np.log1p(z * z / df)
        pred = np.exp(lp)
        growth = R * pred * (1 - hazard); cpm = (R * pred * hazard).sum()
        R = np.r_[cpm, growth]; R /= R.sum()
        cp[t] = R[0] if t < 3 else R[:3].sum() - (R[1:3].sum() if False else 0)  # P(run length 0)
        mu_n = (ka * mu + x[t]) / (ka + 1); ka_n = ka + 1; al_n = al + .5; be_n = be + ka * (x[t] - mu) ** 2 / (2 * (ka + 1))
        mu, ka, al, be = np.r_[mu0, mu_n], np.r_[kappa0, ka_n], np.r_[alpha0, al_n], np.r_[beta0, be_n]
        if len(R) > 120:  # truncate tiny tails
            R, mu, ka, al, be = R[:120], mu[:120], ka[:120], al[:120], be[:120]; R /= R.sum()
    return cp


def cusum(x: np.ndarray, k=0.5, h=4.0) -> np.ndarray:
    sp = sn = 0.0; ev = np.zeros(len(x), int)
    for i, v in enumerate(x):
        sp = max(0.0, sp + v - k); sn = min(0.0, sn + v + k)
        if sp > h: ev[i] = 1; sp = 0.0
        elif sn < -h: ev[i] = -1; sn = 0.0
    return ev


def main() -> int:
    rows = []
    rng = np.random.default_rng(7)
    for tk in ("SPY", "QQQ"):
        df = load(tk)
        days = [g.reset_index(drop=True) for _, g in df.groupby("d") if len(g) >= 70]
        closes = np.array([g.c.iloc[-1] for g in days]); highs = np.array([g.h.max() for g in days]); lows = np.array([g.l.min() for g in days])
        for k in range(21, len(days)):
            g = days[k]
            pcs = closes[k - 21:k]
            tr = np.maximum(highs[k - 20:k] - lows[k - 20:k], np.maximum(abs(highs[k - 20:k] - pcs[:-1]), abs(lows[k - 20:k] - pcs[:-1]))) / pcs[:-1]
            atr = tr.mean(); ret5 = closes[k - 1] / closes[k - 6] - 1
            r = np.log(g.c).diff().fillna(np.log(g.c.iloc[0] / g.o.iloc[0])).values / (atr / np.sqrt(78))
            cp = bocpd(r); cs = cusum(r)
            vw = (g.c * g.v).cumsum() / g.v.cumsum().replace(0, np.nan)
            close = g.c.iloc[-1]
            last_cp_score = None; prev_lvl = None
            for i in range(5, len(g) - 1):
                m = int(g.m.iloc[i]) + 5          # minutes elapsed at this bar's close
                if m < 30 or m > 330: continue
                b = g.iloc[: i + 1]; p = b.c.iloc[-1]; rest = g.iloc[i + 1:]
                s = risk_score(b, m, atr, ret5)
                if m in CPS: last_cp_score = s
                lvl = int(np.searchsorted(M["cuts"], s))
                exc = (b.h.max() - b.o.iloc[0]) / b.o.iloc[0] / atr if p < vw.iloc[i] else (b.o.iloc[0] - b.l.min()) / b.o.iloc[0] / atr
                vw_cross = (np.sign(p - vw.iloc[i]) != np.sign(b.c.iloc[-2] - vw.iloc[i - 1])) and exc >= 0.5
                rows.append(dict(tk=tk, d=g.d.iloc[0], m=m, fresh=s, stale=last_cp_score,
                                 bocpd=cp[i] > 0.5, cusum=cs[i] != 0, cusum_dir=cs[i], stormy_jump=(lvl == 3 and prev_lvl is not None and prev_lvl < 3),
                                 vwap_rev=bool(vw_cross),
                                 dropx=(min(rest.l.min() / p - 1, 0) / atr) <= -0.5, rest_rng=(rest.h.max() - rest.l.min()) / p / atr,
                                 fwd=close / p - 1, move_sign=np.sign(p / g.o.iloc[0] - 1)))
                prev_lvl = lvl
    R = pd.DataFrame(rows)
    dates = sorted(R.d.unique()); split = dates[len(dates) // 2]
    R["half"] = np.where(R.d < split, "H1", "H2")
    L = ["# S139 — Event-driven vs clock-driven intraday regime", "",
         f"SPY+QQQ, {len(dates)} sessions, every 5-min bar 30–330 min ({len(R):,} bar-rows); H1 < {split} ≤ H2.", "",
         "## Q1. Fresh (every bar) vs stale (last fixed checkpoint) rest-of-day risk score", "",
         "| half | AUC fresh | AUC stale | n bars |", "|---|---|---|---|"]
    x = R.dropna(subset=["stale"])
    for h in ("H1", "H2"):
        y = x[x.half == h]
        L.append(f"| {h} | {auc_score(y.dropx.values.astype(float), y.fresh.values):.3f} | {auc_score(y.dropx.values.astype(float), y.stale.values):.3f} | {len(y):,} |")
    # only bars that are NOT checkpoints (where the tab shows a stale value)
    y = x[~x.m.isin(CPS)]
    L += ["", f"Between checkpoints only: AUC fresh {auc_score(y.dropx.values.astype(float), y.fresh.values):.3f} vs stale {auc_score(y.dropx.values.astype(float), y.stale.values):.3f} (n {len(y):,})", ""]

    L += ["## Q2. After an event vs placebo bars (same day, same minute window)", "",
          "| event | half | n events | P(drop ≥ ½ ATR) event / placebo | t | rest range event / placebo | P(continue) event / placebo |", "|---|---|---|---|---|---|---|"]
    for ev in ("bocpd", "cusum", "stormy_jump", "vwap_rev"):
        for h in ("H1", "H2"):
            y = R[R.half == h]
            e = y[y[ev]]
            if len(e) < 30: continue
            # placebo: per event-day, sample the same number of non-event bars
            pl = []
            for d, ge in e.groupby(["tk", "d"]):
                pool = y[(y.tk == d[0]) & (y.d == d[1]) & ~y[ev]]
                if len(pool): pl.append(pool.sample(min(len(ge), len(pool)), random_state=1))
            p = pd.concat(pl) if pl else e.iloc[:0]
            ed = e.groupby("d").dropx.mean(); pd_ = p.groupby("d").dropx.mean()
            jj = ed.index.intersection(pd_.index); diff = (ed[jj] - pd_[jj])
            t = diff.mean() / (diff.std() / np.sqrt(len(diff))) if len(diff) > 2 and diff.std() > 0 else np.nan
            cont = lambda z: (np.sign(z.fwd) == z.move_sign)[z.fwd.abs() >= .001].mean()
            L.append(f"| {ev} | {h} | {len(e):,} | {100 * e.dropx.mean():.1f} / {100 * p.dropx.mean():.1f} % | {t:+.1f} | {e.rest_rng.median():.2f} / {p.rest_rng.median():.2f} | {100 * cont(e):.0f} / {100 * cont(p):.0f} % |")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
