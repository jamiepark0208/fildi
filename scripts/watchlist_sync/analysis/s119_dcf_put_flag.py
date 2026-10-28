"""S119 (A287) — does the DCF "expensive" flag improve short puts beyond IV? Cheap subset run (Jamie 10-28: no new fetches).

Puts: cached S045 panel (weekly 1σ-IV30 put, BS premium, pnl per $ strike, breach), 151 names overlapping the S116 DCF rows.
Flag: S116 point-in-time DCF (research/fair_value/out/dcf_backtest_rows.csv, quarterly) → value/price in the dearest
quintile of that quarter; carried forward ≤ 120 days. Window 2020-02 → 2024-03.
Tests: flagged − rest on pnl (bp/wk) and breach, raw and within week×IV-quintile cells; 3 periods; week-block bootstrap;
shuffled-flag placebo. Pass bar (A287): skip-flagged better pnl AND lower breach, ≥ 2/3 periods, |t| ≥ 2.
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "out" / "opt" / "S119.md"
PERIODS = [("2020-02", "2021-12"), ("2022-01", "2022-12"), ("2023-01", "2024-03")]


def load() -> pd.DataFrame:
    z = np.load(glob.glob(str(HERE / "out" / "opt" / "s045_signal_*.npz"))[0], allow_pickle=True)
    ev = pd.DataFrame({k: z[k] for k in ("ticker", "as_of", "pnl", "breach", "iv30")})
    ev["as_of"] = pd.to_datetime(ev["as_of"])
    d = pd.read_csv(ROOT / "research" / "fair_value" / "out" / "dcf_backtest_rows.csv", parse_dates=["date"])
    d = d[(d.p50 > 0) & (d.price > 0)].copy()
    d["vp"] = d.p50 / d.price
    d["flag"] = (d.groupby("date")["vp"].rank(pct=True) <= 0.2).astype(float)
    ev = ev[ev.ticker.isin(set(d.ticker))].sort_values("as_of")
    m = pd.merge_asof(ev, d[["ticker", "date", "vp", "flag"]].sort_values("date"), left_on="as_of", right_on="date",
                      by="ticker", direction="backward", tolerance=pd.Timedelta(days=120))
    m = m.dropna(subset=["flag"]).copy()
    m["wk"] = m.as_of.dt.to_period("W").astype(str)
    m["ivq"] = m.groupby("wk")["iv30"].rank(pct=True).mul(5).clip(upper=4.999).astype(int)
    return m


def diff(m: pd.DataFrame, col: str, within: bool) -> float:
    if not within:
        return m.loc[m.flag == 1, col].mean() - m.loc[m.flag == 0, col].mean()
    g = m.groupby(["wk", "ivq", "flag"])[col].mean().unstack("flag").dropna()
    n = m[m.flag == 1].groupby(["wk", "ivq"]).size().reindex(g.index)
    return float(np.average(g[1.0] - g[0.0], weights=n))


def boot_t(m: pd.DataFrame, col: str, within: bool, n=300, seed=7) -> float:
    rng = np.random.default_rng(seed)
    weeks = m.wk.unique()
    blocks = {w: g for w, g in m.groupby("wk")}
    # 4-week blocks
    wk_sorted = np.sort(weeks)
    chunks = [wk_sorted[i:i + 4] for i in range(0, len(wk_sorted), 4)]
    est = diff(m, col, within)
    sims = []
    for _ in range(n):
        pick = rng.integers(0, len(chunks), len(chunks))
        s = pd.concat([blocks[w].assign(wk=f"{w}_{j}") for j, c in enumerate(pick) for w in chunks[c]])
        sims.append(diff(s, col, within))
    sd = float(np.std(sims))
    return est / sd if sd > 0 else float("nan")


def main():
    m = load()
    lines = [f"# S119 — DCF expensive flag on weekly 1σ short puts (subset, cached S045 panel)\n",
             f"{len(m):,} puts · {m.ticker.nunique()} names · {m.as_of.min():%Y-%m} → {m.as_of.max():%Y-%m} · "
             f"flagged {m.flag.mean():.1%}\n",
             "| slice | n flagged | pnl bp/wk flagged | rest | Δ raw | Δ IV-matched | breach flagged | rest | Δ IV-matched |",
             "|---|---|---|---|---|---|---|---|---|"]
    for name, sub in [("all", m)] + [(f"{a}→{b}", m[(m.as_of >= a) & (m.as_of < pd.Period(b).end_time.strftime('%Y-%m-%d'))])
                                     for a, b in PERIODS]:
        f, r = sub[sub.flag == 1], sub[sub.flag == 0]
        lines.append(f"| {name} | {len(f):,} | {f.pnl.mean()*1e4:+.1f} | {r.pnl.mean()*1e4:+.1f} | "
                     f"{diff(sub,'pnl',False)*1e4:+.1f} | {diff(sub,'pnl',True)*1e4:+.1f} | {f.breach.mean():.1%} | "
                     f"{r.breach.mean():.1%} | {diff(sub,'breach',True)*100:+.1f} pp |")
    t_p, t_b = boot_t(m, "pnl", True), boot_t(m, "breach", True)
    rng = np.random.default_rng(11)
    plac = []
    for _ in range(50):
        s = m.copy()
        s["flag"] = s.groupby("wk")["flag"].transform(lambda x: rng.permutation(x.values))
        plac.append(diff(s, "pnl", True) * 1e4)
    lines += ["", f"Block-bootstrap t (IV-matched, 4-week blocks): pnl {t_p:+.2f} · breach {t_b:+.2f}",
              f"Placebo (flag shuffled within week, 50×): pnl Δ mean {np.mean(plac):+.1f} bp, sd {np.std(plac):.1f}",
              "Skip-flagged arm = rest column (same per-$ collateral basis); half-size arm = midpoint."]
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
