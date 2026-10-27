"""Fair value round 2, steps 1–2 (NEXT.md): reverse-engineer the price and attribute the fv-1.1.0 gaps.
Per valued name: gap = log(FV / price), street = log(LSEG PT / price), own vs applied forward P/E, PVGO share,
growth (FY1→FY2, LTG), quality, leverage, risk, revisions. Then: where the bad gaps concentrate (sector, peer group,
traits) and which inputs explain the gap cross-sectionally (standardised OLS + GBM permutation importance, out-of-fold).
"Bad" = |gap| in the worst quintile AND the street disagrees with the model (|gap − street| > 0.4 log).
Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/gap_attribution.py"""
import json, math, sys
from pathlib import Path
import numpy as np
import pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/watchlist_sync"))
from build_plan import connect, rows

OUT = Path(__file__).parent / "out"
RF, ERP = 0.042, 0.05  # same order as the model's CAPM inputs

SQL = """
WITH s AS (SELECT DISTINCT ON (ticker) * FROM fair_value_snapshots ORDER BY ticker, as_of DESC),
sig AS (SELECT DISTINCT ON (ticker) ticker, eps_mean_fy1, pt_mean, arm_rank, eps_drift_30d_pct, short_pct, price_close
        FROM lseg_research.signals_daily WHERE as_of >= CURRENT_DATE - 10 ORDER BY ticker, as_of DESC),
sig90 AS (SELECT DISTINCT ON (ticker) ticker, pt_mean pt_old FROM lseg_research.signals_daily
          WHERE as_of <= CURRENT_DATE - 60 AND as_of >= CURRENT_DATE - 120 AND pt_mean > 0 ORDER BY ticker, as_of DESC),
ib AS (SELECT DISTINCT ON (UPPER(oftic), fpi) UPPER(oftic) ticker, fpi, meanest FROM wrds_research.ibes_statsum
       WHERE measure='EPS' AND fpi IN ('0','2') AND statpers >= CURRENT_DATE - 120 AND meanest IS NOT NULL AND oftic IS NOT NULL
       ORDER BY UPPER(oftic), fpi, statpers DESC)
SELECT s.ticker, s.price, s.fair_value, s.mode, s.votes, s.cyclical, s.value_trap, s.implied_growth, s.confidence,
       r.primary_peer_group_id gid, pg.name gname,
       f.forward_pe, f.earnings_per_share, f.revenue_growth_yoy, f.return_on_equity, f.roic, f.operating_margin, f.gross_margin,
       f.debt_to_equity, f.total_debt, f.cash_and_equivalents, f.ebitda, f.beta, f.shares_outstanding, f.sbc_to_revenue,
       f.dividend_yield, f.fcf_yield,
       sig.eps_mean_fy1, sig.pt_mean, sig.arm_rank, sig.eps_drift_30d_pct, sig.short_pct, sig90.pt_old,
       i0.meanest ltg, i2.meanest fy2
FROM s JOIN ticker_registry r ON r.ticker = s.ticker AND COALESCE(r.is_active, true)
LEFT JOIN peer_groups pg ON pg.id = r.primary_peer_group_id
LEFT JOIN ticker_fundamentals f ON f.ticker = s.ticker
LEFT JOIN sig ON sig.ticker = s.ticker LEFT JOIN sig90 ON sig90.ticker = s.ticker
LEFT JOIN ib i0 ON i0.ticker = s.ticker AND i0.fpi = '0' LEFT JOIN ib i2 ON i2.ticker = s.ticker AND i2.fpi = '2'
WHERE s.fair_value > 0 AND s.price > 0
"""


def f(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else np.nan
    except (TypeError, ValueError):
        return np.nan


def load():
    with connect() as c:
        d = pd.DataFrame(rows(c, SQL))
    for col in d.columns:
        if col not in ("ticker", "mode", "votes", "gid", "gname", "confidence", "cyclical", "value_trap"):
            d[col] = d[col].map(f)
    d["sector"] = d.gid.fillna("unknown").str.split(".").str[0]
    d["gap"] = np.log(d.fair_value / d.price)
    d["street"] = np.log(d.pt_mean / d.price).where(d.pt_mean > 0)
    # forward EPS: LSEG FY1 when sane (P/E 3..150), else vendor forward P/E
    pe_lseg = d.price / d.eps_mean_fy1
    d["fy1"] = d.eps_mean_fy1.where((pe_lseg >= 3) & (pe_lseg <= 150), d.price / d.forward_pe.where(d.forward_pe > 0))
    d["own_pe"] = d.price / d.fy1
    votes = d.votes.map(lambda v: {x["name"]: x["value"] for x in (v or [])})
    kept = d.votes.map(lambda v: [x["name"] for x in (v or []) if x.get("kept")])
    d["n_kept"] = kept.map(len)
    d["peer_pe_applied"] = votes.map(lambda v: v.get("peerForwardPe", np.nan)) / d.fy1
    d["street_kept"] = kept.map(lambda k: "analystTarget" in k)
    d["g12"] = (d.fy2 / d.fy1 - 1).where((d.fy2 / d.fy1 > 0.5) & (d.fy2 / d.fy1 < 2.5))
    d["ltg"] = (d.ltg / 100).where(d.ltg.abs() < 100)
    beta = d.beta.clip(0.5, 2.0).fillna(1.0)
    d["r"] = RF + beta * ERP
    d["pvgo_share"] = (1 - (d.fy1 / d.r) / d.price).where(d.fy1 > 0)  # share of price that is future growth
    d["net_debt_ebitda"] = ((d.total_debt - d.cash_and_equivalents) / d.ebitda).where(d.ebitda > 0).clip(-5, 15)
    d["log_cap"] = np.log(d.price * d.shares_outstanding)
    d["pt_chg_3m"] = np.log(d.pt_mean / d.pt_old).where(d.pt_old > 0)
    d["eps_vs_trailing"] = np.log(d.fy1 / d.earnings_per_share).where((d.earnings_per_share > 0) & (d.fy1 > 0))
    d["model_vs_street"] = d.gap - d.street
    return d


FEATS = ["g12", "ltg", "revenue_growth_yoy", "return_on_equity", "roic", "operating_margin", "gross_margin", "net_debt_ebitda",
         "beta", "log_cap", "arm_rank", "pt_chg_3m", "eps_drift_30d_pct", "short_pct", "sbc_to_revenue", "dividend_yield",
         "eps_vs_trailing", "cyclical_i", "value_trap_i", "street"]


def attribution(d):
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.inspection import permutation_importance
    from sklearn.model_selection import KFold
    feats = [c for c in FEATS if d[c].notna().sum() >= 50]
    X = d[feats].copy()
    y = d.gap.clip(-2.5, 2.5).values
    # standardised OLS on rank-normalised features (robust to fat tails), missing → median
    Z = X.rank(pct=True).fillna(0.5) - 0.5
    Z = (Z - Z.mean()) / Z.std().replace(0, 1)
    A = np.c_[np.ones(len(Z)), Z.values]
    beta, *_ = np.linalg.lstsq(A, y, rcond=None)
    resid = y - A @ beta
    r2_ols = 1 - resid.var() / y.var()
    sig2 = resid.var() * len(y) / (len(y) - A.shape[1])
    se = np.sqrt(np.diag(sig2 * np.linalg.pinv(A.T @ A)))
    ols = pd.DataFrame({"coef": beta[1:], "t": beta[1:] / se[1:]}, index=feats)
    # sector dummies in the GBM so it can learn sector-specific levels
    Xg = pd.concat([X, pd.get_dummies(d.sector, prefix="sec", dtype=float)], axis=1)
    pred = np.zeros(len(y)); imps = []
    for tr, te in KFold(5, shuffle=True, random_state=0).split(Xg):
        m = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=300, min_samples_leaf=20, random_state=0)
        m.fit(Xg.iloc[tr], y[tr]); pred[te] = m.predict(Xg.iloc[te])
        pi = permutation_importance(m, Xg.iloc[te], y[te], n_repeats=5, random_state=0)
        imps.append(pi.importances_mean)
    r2_gbm = 1 - ((y - pred) ** 2).mean() / y.var()
    imp = pd.Series(np.mean(imps, 0), index=Xg.columns)
    sec_imp = imp[imp.index.str.startswith("sec_")].sum()
    imp = imp[~imp.index.str.startswith("sec_")]
    imp["sector (all dummies)"] = sec_imp
    return ols, r2_ols, imp.sort_values(ascending=False), r2_gbm, pred


def main():
    d = load()
    d["cyclical_i"] = d.cyclical.astype(float); d["value_trap_i"] = d.value_trap.astype(float)
    n = len(d)
    absg = d.gap.abs()
    cut = absg.quantile(0.8)
    d["bad"] = (absg >= cut) & ((d.model_vs_street.abs() > 0.4) | d.street.isna())
    d["dir"] = np.where(d.gap > 0, "too high", "too low")
    out = []
    p = out.append
    p(f"# Fair value gap attribution (fv-1.1.0, {pd.Timestamp.today().date()})\n")
    p(f"Valued {n}. |log gap| median {absg.median():.2f}, worst-quintile cut {cut:.2f} (≈ {math.exp(cut)-1:+.0%} / {math.exp(-cut)-1:+.0%}). "
      f"Bad (worst quintile and street disagrees > 0.4 log) = {d.bad.sum()} "
      f"({(d.bad & (d.gap > 0)).sum()} too high, {(d.bad & (d.gap < 0)).sum()} too low).")
    p(f"Street (LSEG PT) available {d.street.notna().sum()}; rank corr(model gap, street gap) = "
      f"{d[['gap','street']].corr('spearman').iloc[0,1]:+.2f}; median |model − street| {d.model_vs_street.abs().median():.2f} log.\n")

    p("## Step 1: what the price implies (medians)\n")
    p("| group | n | own fwd P/E | peer P/E applied | PVGO share | FY1→FY2 g | LTG | street gap | model gap |")
    p("|---|---|---|---|---|---|---|---|---|")
    for lab, m in [("bad: too low", d.bad & (d.gap < 0)), ("bad: too high", d.bad & (d.gap > 0)), ("rest", ~d.bad)]:
        s = d[m]
        p(f"| {lab} | {len(s)} | {s.own_pe.median():.1f} | {s.peer_pe_applied.median():.1f} | {s.pvgo_share.median():.0%} | "
          f"{s.g12.median():+.0%} | {s.ltg.median():.0%} | {s.street.median():+.2f} | {s.gap.median():+.2f} |")

    p("\n## Where bad gaps concentrate\n")
    for key, minn in [("sector", 8), ("gname", 6), ("mode", 5)]:
        g = d.groupby(key).agg(n=("bad", "size"), bad=("bad", "sum"), hi=("gap", lambda x: 0), med_gap=("gap", "median"),
                               med_street=("street", "median"))
        g["hi"] = d[d.bad & (d.gap > 0)].groupby(key).size().reindex(g.index).fillna(0).astype(int)
        g["rate"] = g.bad / g.n
        g = g[g.n >= minn].sort_values("rate", ascending=False).head(12)
        base = d.bad.mean()
        p(f"**By {key}** (base rate {base:.0%}, n ≥ {minn}):\n")
        p("| " + key + " | n | bad | of which too high | rate | lift | median gap | median street |")
        p("|---|---|---|---|---|---|---|---|")
        for k, r in g.iterrows():
            p(f"| {k} | {r.n} | {r.bad} | {r.hi} | {r.rate:.0%} | {r.rate/base:.1f}× | {r.med_gap:+.2f} | {r.med_street:+.2f} |")
        p("")

    p("**Traits (rate of bad when trait true vs false):**\n")
    p("| trait | n true | bad rate true | bad rate false | lift | direction when bad |")
    p("|---|---|---|---|---|---|")
    traits = {
        "FY1→FY2 growth > 25 %": d.g12 > 0.25, "LTG > 20 %": d.ltg > 0.20, "PVGO share > 60 %": d.pvgo_share > 0.6,
        "own fwd P/E > 2× applied peer P/E": d.own_pe > 2 * d.peer_pe_applied, "own fwd P/E < 0.5× applied": d.own_pe < 0.5 * d.peer_pe_applied,
        "net debt / EBITDA > 3": d.net_debt_ebitda > 3, "cyclical flag": d.cyclical, "value-trap flag": d.value_trap,
        "FY1 > 1.5× trailing EPS": d.eps_vs_trailing > math.log(1.5), "FY1 < 0.67× trailing EPS": d.eps_vs_trailing < math.log(0.67),
        "ROE > 30 %": d.return_on_equity > 0.30, "beta > 1.6": d.beta > 1.6, "cap < $10B": d.log_cap < math.log(1e10),
        "cap > $200B": d.log_cap > math.log(2e11), "PT up > 15 % in 3m": d.pt_chg_3m > 0.14, "street target not kept": ~d.street_kept,
        "dividend yield > 4 %": d.dividend_yield > 0.04, "≤ 2 methods kept": d.n_kept <= 2,
    }
    for k, m in traits.items():
        m = m.fillna(False).astype(bool)
        if m.sum() < 8: continue
        rt, rf_ = d.bad[m].mean(), d.bad[~m].mean()
        hi = (d.bad & m & (d.gap > 0)).sum(); lo = (d.bad & m & (d.gap < 0)).sum()
        p(f"| {k} | {m.sum()} | {rt:.0%} | {rf_:.0%} | {rt/max(rf_,1e-9):.1f}× | {lo} low / {hi} high |")

    ols, r2o, imp, r2g, pred = attribution(d)
    p(f"\n## Step 2: what explains log(FV / price) cross-sectionally\n")
    p(f"OLS on rank-normalised inputs R² {r2o:.2f} (in-sample); GBM + sector dummies out-of-fold R² {r2g:.2f}.\n")
    p("| input | OLS coef (per 1 sd) | t | GBM permutation importance |")
    p("|---|---|---|---|")
    for k in imp.index:
        o = ols.loc[k] if k in ols.index else None
        p(f"| {k} | {o.coef:+.3f} | {o.t:+.1f} | {imp[k]:.3f} |" if o is not None else f"| {k} | | | {imp[k]:.3f} |")
    # per-sector: top 3 OLS drivers by |t| within sector
    p("\n**Per sector, strongest single drivers (rank corr with gap, n ≥ 25):**\n")
    p("| sector | n | top drivers (ρ) |")
    p("|---|---|---|")
    for sec, s in d.groupby("sector"):
        if len(s) < 25: continue
        rho = s[FEATS].corrwith(s.gap, method="spearman").dropna()
        top = rho.reindex(rho.abs().sort_values(ascending=False).index).head(4)
        p(f"| {sec} | {len(s)} | " + ", ".join(f"{k} {v:+.2f}" for k, v in top.items()) + " |")

    p("\n## Worst 40 bad names\n")
    p("| ticker | sector | group | gap | street | own P/E | peer P/E | g12 | LTG | PVGO | flags |")
    p("|---|---|---|---|---|---|---|---|---|---|---|")
    w = d[d.bad].reindex(d[d.bad].gap.abs().sort_values(ascending=False).index).head(40)
    for _, r in w.iterrows():
        fl = ",".join(x for x, c in [("cyc", r.cyclical), ("trap", r.value_trap), ("PTnotkept", not r.street_kept)] if c)
        p(f"| {r.ticker} | {r.sector} | {r.gname or '-'} | {math.exp(r.gap)-1:+.0%} | "
          f"{'' if pd.isna(r.street) else f'{math.exp(r.street)-1:+.0%}'} | {r.own_pe:.1f} | {r.peer_pe_applied:.1f} | "
          f"{r.g12:+.0%} | {r.ltg:.0%} | {r.pvgo_share:.0%} | {fl} |".replace("nan%", "-").replace("+nan%", "-").replace("| nan |", "| - |"))
    OUT.mkdir(exist_ok=True)
    (OUT / "gap_attribution.md").write_text("\n".join(out) + "\n")
    d.drop(columns=["votes"]).to_csv(OUT / "gap_attribution.csv", index=False)
    print("\n".join(out))


if __name__ == "__main__":
    main()
