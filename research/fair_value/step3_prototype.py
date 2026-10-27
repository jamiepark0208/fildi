"""Fair value round 2, step 3 prototype (NEXT.md): fixes for the gap patterns in out/gap_attribution.md, judged offline
on today's cross-section. Accuracy = pricing error |log(FV / price)| (Liu–Nissim–Thomas); every fitted multiple is
out-of-fold (5-fold), so no name prices itself.
Variants (all recompute the fv-1.1.0 blend from the stored votes):
  V0 fv-1.1.0 as stored (sanity: recomputed trimmed blend must match the snapshot)
  V1 warranted P/E v2: GBM of log forward P/E on growth, quality, risk, size + sector (out-of-fold) replaces warrantedPe
  V2 street anchor: trim the internal votes, then blend with the de-biased street target at weight 1/3 (never trimmed)
  V3 V1 + V2
  V4 V3, and the warranted P/E also replaces peerForwardPe when own P/E is > 2× or < 0.5× the peer P/E
  V5 V4 + needs ≥ 2 internal votes (not street, not StarMine) or one earnings-based vote, else no value (GH/NTRA: one DCF on tiny FCF)
  V6 V5 + street weight 1/2 when the multiple doesn't fit (own P/E outside 0.5–2× peer/warranted, or PVGO > 60 %)
Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/step3_prototype.py"""
import math
from pathlib import Path
import numpy as np
import pandas as pd
from gap_attribution import load

OUT = Path(__file__).parent / "out"
BIAS = 0.02
EARNINGS = {"peerForwardPe", "warrantedPe", "grahamForward", "ohlsonJuettner", "peerPffo", "excessReturns"}  # analystBias in fv-1.1.0
FEATS = ["g12", "ltg", "revenue_growth_yoy", "eps_vs_trailing", "return_on_equity", "operating_margin", "gross_margin",
         "beta", "net_debt_ebitda", "log_cap", "arm_rank", "dividend_yield"]


def trimmed(xs):
    xs = sorted(xs)
    if len(xs) >= 4: xs = xs[1:-1]
    elif len(xs) < 2: return np.nan
    else: return float(np.median(xs))
    return float(np.mean(xs))


def warranted_pe(d):
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.model_selection import KFold
    m = (d.own_pe > 3) & (d.own_pe < 150) & (d["mode"] != "reit")
    s = d[m]
    X = pd.concat([s[FEATS], pd.get_dummies(s.sector, prefix="sec", dtype=float)], axis=1)
    y = np.log(s.own_pe.values)
    pred = np.full(len(s), np.nan)
    for tr, te in KFold(5, shuffle=True, random_state=0).split(X):
        g = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=300, min_samples_leaf=15, random_state=0)
        g.fit(X.iloc[tr], y[tr]); pred[te] = g.predict(X.iloc[te])
    r2 = 1 - np.nanmean((y - pred) ** 2) / y.var()
    out = pd.Series(np.nan, index=d.index); out[m] = np.exp(pred)
    return out, r2


def misfit(r, wpe_i):
    ref = r.peer_pe_applied if not np.isnan(r.peer_pe_applied) else wpe_i
    return (r.pvgo_share > 0.6) or (not np.isnan(ref) and not np.isnan(r.own_pe) and not 0.5 <= r.own_pe / ref <= 2)


def blend(d, wpe, street_w, replace_peer, min_internal=0, misfit_w=None):
    res = []
    for i, r in d.iterrows():
        v = {x["name"]: x["value"] for x in (r.votes or [])}
        street = v.pop("analystTarget", None)
        internal = [k for k in v if k != "starmine"]
        if min_internal and len(internal) < min_internal and not any(k in EARNINGS for k in internal):
            res.append(np.nan); continue
        w = misfit_w if misfit_w and misfit(r, wpe[i]) else street_w
        if not np.isnan(wpe[i]) and r.fy1 > 0:
            if "warrantedPe" in v: v["warrantedPe"] = wpe[i] * r.fy1
            if replace_peer and "peerForwardPe" in v and (r.own_pe > 2 * r.peer_pe_applied or r.own_pe < 0.5 * r.peer_pe_applied):
                v["peerForwardPe"] = wpe[i] * r.fy1
        logs = [math.log(x / r.price) for x in v.values() if x and x > 0]
        if w and street:
            core = trimmed(logs) if len(logs) >= 2 else (logs[0] if logs else np.nan)
            s = math.log(street / r.price)
            res.append(s if np.isnan(core) else (1 - w) * core + w * s)
        else:
            if street: logs.append(math.log(street / r.price))
            res.append(trimmed(logs))
    return pd.Series(res, index=d.index)


def summarize(d, gap, name, base_bad=None):
    a = gap.abs()
    groups = {
        "own P/E > 2× peer": d.own_pe > 2 * d.peer_pe_applied, "own P/E < 0.5× peer": d.own_pe < 0.5 * d.peer_pe_applied,
        "PVGO > 60 %": d.pvgo_share > 0.6, "fintech": d.sector == "fintech", "Semis design": d.gname == "Semiconductors — Design",
        "Med devices": d.gname == "Medical Devices & Equipment", "Software": d.gname == "Enterprise Software & Cloud",
        "Autos & EVs": d.gname == "Autos & EVs", "financials+REIT+utility": d.sector.isin(["financials", "real_estate", "utilities"]),
    }
    row = {"variant": name, "n": int(gap.notna().sum()), "median |log|": a.median(), "> 50 % off": (a > math.log(1.5)).mean(),
           "> 2× off": (a > math.log(2)).mean(), "bias (median log)": gap.median(),
           "rank ρ vs street": pd.concat([gap, d.street], axis=1).corr("spearman").iloc[0, 1]}
    for k, msk in groups.items():
        row[k] = a[msk.fillna(False)].median()
    return row


def main():
    d = load()
    wpe, r2 = warranted_pe(d)
    stored = d.gap
    v0 = blend(d, pd.Series(np.nan, index=d.index), 0, False)
    match = (v0 - stored).abs() < 0.02
    rows = [summarize(d, stored, "V0 fv-1.1.0 (stored)")]
    rows.append(summarize(d, blend(d, wpe, 0, False), "V1 warranted P/E v2"))
    rows.append(summarize(d, blend(d, pd.Series(np.nan, index=d.index), 1 / 3, False), "V2 street anchor 1/3"))
    v3 = blend(d, wpe, 1 / 3, False); rows.append(summarize(d, v3, "V3 = V1 + V2"))
    v4 = blend(d, wpe, 1 / 3, True); rows.append(summarize(d, v4, "V4 = V3 + replace peer P/E on 2× mismatch"))
    v5 = blend(d, wpe, 1 / 3, True, 2); rows.append(summarize(d, v5, "V5 = V4 + ≥ 2 internal votes"))
    v6 = blend(d, wpe, 1 / 3, True, 2, 0.5); rows.append(summarize(d, v6, "V6 = V5 + street 1/2 on misfit"))
    t = pd.DataFrame(rows).set_index("variant").T
    lines = [f"# Step 3 prototype ({pd.Timestamp.today().date()})", "",
             f"Recomputed blend matches stored fv-1.1.0 on {match.mean():.0%} of {len(d)} names "
             f"(rest: stored value uses inputs the vote list doesn't carry). Warranted P/E v2 out-of-fold R² on log P/E {r2:.2f}.", "",
             "Pricing error |log(FV/price)| unless stated; lower is better. Street ρ is circular for V2–V4 (street is in the blend).", "",
             "| metric | " + " | ".join(t.columns) + " |", "|---|" + "---|" * len(t.columns)]
    for k, r in t.iterrows():
        fmt = (lambda x: f"{x:.0%}") if "off" in k else (lambda x: f"{x:+.2f}") if ("bias" in k or "ρ" in k) else (lambda x: f"{x:.0f}" if k == "n" else f"{x:.2f}")
        lines.append(f"| {k} | " + " | ".join(fmt(x) for x in r.values) + " |")
    d["v4"] = v6; d["wpe"] = wpe
    w = d.reindex(d.gap.abs().sort_values(ascending=False).index).head(30)
    lines += ["", "## Worst 30 under fv-1.1.0: before → V6", "", "| ticker | group | own P/E | peer P/E | warranted v2 | fv-1.1.0 | V6 | street |", "|---|---|---|---|---|---|---|---|"]
    pct = lambda x: "-" if pd.isna(x) else f"{math.exp(x) - 1:+.0%}"
    for _, r in w.iterrows():
        lines.append(f"| {r.ticker} | {r.gname or r.sector} | {r.own_pe:.1f} | {r.peer_pe_applied:.1f} | "
                     f"{'-' if pd.isna(r.wpe) else f'{r.wpe:.1f}'} | {pct(r.gap)} | {pct(r.v4)} | {pct(r.street)} |")
    (OUT / "step3_prototype.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
