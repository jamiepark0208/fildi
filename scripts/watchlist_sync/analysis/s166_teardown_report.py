import sys
import numpy as np
import pandas as pd

df = pd.read_parquet(sys.argv[1]).dropna(subset=["ST", "hold_exp_ret"])
df["d"] = pd.to_datetime(df.d)
df["era"] = np.where(df.d <= "2023-12-31", "train", np.where(df.d >= "2024-01-01", "test", "gap"))
df["m"] = df.d.dt.to_period("M")
sgn = np.where(df.sid == "bull_call_debit", 1, -1)
df["dlt"] = df.delta0.abs().fillna(0.34) * sgn  # net spread delta per 1 spread (per share)
df["stk"] = df.dlt * (df.ST - df.S) / df.debit  # Δ-matched stock return on the same $ debit, to expiry
df["hx"] = df.hold_exp_ret
df["edge"] = df.hx - df.stk
df["mv"] = sgn * df.move_sig


def pooled(x, c):  # Σret / Σdays → bp per $debit per day
    return 1e4 * x[c].sum() / x.T_days.sum()


def mt(x, c="edge"):
    g = x.groupby("m")[c].mean()
    return g.mean() / (g.std() / np.sqrt(len(g))) if len(g) > 2 else np.nan


def line(x):
    return (f"n={len(x):6d} hold={x.hx.mean():+.3f} win={(x.hx>0).mean():.2f} stock={x.stk.mean():+.3f} "
            f"edge={x.edge.mean():+.3f} ({pooled(x,'edge'):+.1f}bp/d) mt={mt(x):+.2f}")


print(f"delta0 present: {df.delta0.notna().mean():.2f}  median |Δ| {df.delta0.abs().median():.2f}")
for sid in ["bull_call_debit", "bear_put_debit"]:
    for dte in [30, 45]:
        for ent in ["trend", "low_iv"]:
            s = df[(df.sid == sid) & (df.dte == dte) & (df.entry == ent)]
            print(f"{sid:16s} d{dte} {ent:6s} TRAIN {line(s[s.era=='train'])}\n{'':31s} TEST  {line(s[s.era=='test'])}")

for sid in ["bull_call_debit", "bear_put_debit"]:
    s = df[(df.sid == sid) & (df.dte == 45) & (df.entry == "trend")]
    tr = s[s.era == "train"]
    print(f"\n#### {sid} d45 trend, hold-to-expiry: P(move in our direction) train={(tr.mv>0).mean():.2f}")
    print("move bucket (σ) → hold ret vs Δ-stock ret on same $ (where spreads beat stock):")
    b = pd.cut(tr.mv, [-9, -0.5, 0, 0.25, 0.5, 0.75, 1, 1.5, 9])
    print(tr.groupby(b, observed=True).agg(share=("hx", lambda v: len(v) / len(tr)), hold=("hx", "mean"), stock=("stk", "mean"), edge=("edge", "mean")).round(3).to_string())
    print("entry-feature quintiles (train): edge = hold − Δ-stock (per $debit), P(dir)=P(move>0)")
    for f in ["ivr", "iv", "iv_rv20", "iv_rv60", "trend_gap", "pb", "mom60", "debit_frac"]:
        x = tr.dropna(subset=[f])
        q = pd.qcut(x[f], 5, duplicates="drop")
        g = x.groupby(q, observed=True).agg(edge=("edge", "mean"), hold=("hx", "mean"), pdir=("mv", lambda v: (v > 0).mean()))
        print(f"  {f:10s} " + " | ".join(f"{iv.left:.3g}-{iv.right:.3g}: e{r.edge:+.2f} h{r.hold:+.2f} p{r.pdir:.2f}" for iv, r in g.iterrows()))
    x = tr.dropna(subset=["spy_up"])
    print("  spy>200d " + " | ".join(f"{k}: e{v.edge.mean():+.2f} h{v.hx.mean():+.2f} p{(v.mv>0).mean():.2f} n{len(v)}" for k, v in x.groupby("spy_up")))
