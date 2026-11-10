"""S184 — pooled fine-tuned Kronos as a CROSS-SECTIONAL ranker (Jamie 11-10: 'do what you suggested').

The one Kronos use with published evidence (Rahimikia et al.: Chronos R² < 0 yet ranked-portfolio Sharpe high, pre-cost):
don't trust the level, rank names against each other. Runs in ~/.fildi/kronos/venv.

Universe: S175 long-call names with ≥ 400 daily bars before 2024-06-28, top 300 by median $ volume.
Fine-tune: Kronos-small predictor (tokenizer frozen), pooled windows 64 + 21 bars, step 10, ≤ 2024-06-28 (pretrain cutoff),
lookback-only z-score (S181 fix), 2 epochs, last 10 % of dates = validation.
Test: Monday origins every 2 weeks 2024-07 → (21-session horizon). Per name: fine-tuned 8 paths, zero-shot 4 paths.
Signals: mu (mean predicted 21-d log return), mu/sd. Comparators: −ret20 (reversal), mom 12-1.
Pre-registered pass: fine-tuned mu rank IC > 0 with t ≥ 2 on NON-overlapping 4-week origins, same sign both halves
(2024-07→2025-06 / 2025-07→), and S175 long calls (0.50Δ 30 DTE) in the top fifth by mu beat all calls that Monday,
month t ≥ 2. Else RULE NO-LIFT for 'rank by Kronos mu'.
"""
from __future__ import annotations

import math
import pickle
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
import torch

sys.path.insert(0, str(Path.home() / ".fildi/kronos/repo"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import Kronos, KronosPredictor, KronosTokenizer  # noqa: E402
from s180_kronos_calls import dsn  # noqa: E402

LOOK, H, EPOCHS, LR = 64, 21, 2, 2e-5
STEP = int(sys.argv[sys.argv.index("--step") + 1]) if "--step" in sys.argv else 10
CUT = pd.Timestamp("2024-06-28")
NNAMES = int(sys.argv[sys.argv.index("--names") + 1]) if "--names" in sys.argv else 300
SAVE = Path.home() / f".fildi/kronos/finetuned/pooled_L64_n{NNAMES}"
FC = Path.home() / f".fildi/cache/s184_fc_{NNAMES}.pkl"
COLS = ["open", "high", "low", "close", "volume", "amount"]


def stamps(ts):
    return np.stack([ts.dt.minute, ts.dt.hour, ts.dt.weekday, ts.dt.day, ts.dt.month], 1).astype(np.float32)


def load_all():
    names = sorted({x["t"] for x in pickle.load(open(Path.home() / ".fildi/cache/s175_trades.pkl", "rb")) if x["s"] == "long_call"})
    with psycopg.connect(dsn()) as c:
        r = c.execute("""SELECT ticker, date, open::float8, high::float8, low::float8, close::float8, coalesce(volume,0)::float8
                         FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND close > 0 AND open > 0 AND high > 0
                         AND low > 0 ORDER BY ticker, date""", (names,)).fetchall()
    df = pd.DataFrame(r, columns=["ticker", "date", "open", "high", "low", "close", "volume"])
    df["date"] = pd.to_datetime(df["date"]); df["amount"] = df["close"] * df["volume"]
    out = {}
    for t, g in df.groupby("ticker"):
        g = g.reset_index(drop=True)
        if (g["date"] <= CUT).sum() >= 400:
            out[t] = g
    liq = sorted(out, key=lambda t: -float(out[t]["amount"].tail(500).median()))[:NNAMES]
    return {t: out[t] for t in liq}


def windows(dfs):
    ws = []
    for g in dfs.values():
        g = g[g["date"] <= CUT]
        x, s, d = g[COLS].values.astype(np.float32), stamps(g["date"]), g["date"].values
        for i in range(0, len(g) - LOOK - H + 1, STEP):
            w = x[i:i + LOOK + H]; mu, sd = w[:LOOK].mean(0), w[:LOOK].std(0)
            ws.append((d[i + LOOK + H - 1], np.clip((w - mu) / (sd + 1e-5), -5, 5), s[i:i + LOOK + H]))
    ws.sort(key=lambda z: z[0])
    k = int(len(ws) * 0.9)
    return [(a, b) for _, a, b in ws[:k]], [(a, b) for _, a, b in ws[k:]]


def finetune(tok, mdl, train, val, dev):
    opt = torch.optim.AdamW(mdl.parameters(), lr=LR, betas=(0.9, 0.95), weight_decay=0.1)
    rng = np.random.default_rng(184)

    def batches(ws, shuffle):
        idx = rng.permutation(len(ws)) if shuffle else np.arange(len(ws))
        for b in range(0, len(idx), 32):
            sel = [ws[k] for k in idx[b:b + 32]]
            yield (torch.tensor(np.stack([a for a, _ in sel])).to(dev), torch.tensor(np.stack([z for _, z in sel])).to(dev))

    def loss_on(bx, bs):
        with torch.no_grad():
            t0, t1 = tok.encode(bx, half=True)
        lg = mdl(t0[:, :-1], t1[:, :-1], bs[:, :-1, :])
        return mdl.head.compute_loss(lg[0], lg[1], t0[:, 1:], t1[:, 1:])[0]

    best = math.inf
    for ep in range(EPOCHS):
        mdl.train(); tl = []; t0 = time.time()
        for n, (bx, bs) in enumerate(batches(train, True)):
            loss = loss_on(bx, bs); opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(mdl.parameters(), 3.0); opt.step(); tl.append(loss.item())
            if n % 200 == 0:
                print(f"  ep {ep + 1} batch {n} loss {np.mean(tl[-200:]):.4f} · {time.time() - t0:.0f}s", flush=True)
        mdl.eval()
        with torch.no_grad():
            vl = float(np.mean([loss_on(bx, bs).item() for bx, bs in batches(val, False)]))
        print(f"epoch {ep + 1}/{EPOCHS} train {np.mean(tl):.4f} val {vl:.4f}", flush=True)
        if vl < best:
            best = vl; SAVE.mkdir(parents=True, exist_ok=True); mdl.save_pretrained(SAVE)
    return Kronos.from_pretrained(SAVE)


def forecast(pred, dfs, origins, paths):
    out = {}
    t0 = time.time()
    for n, o in enumerate(origins):
        hs, keys = [], []
        for t, g in dfs.items():
            h = g[g["date"] <= o].iloc[-LOOK:]
            if len(h) == LOOK and (o - h["date"].iloc[-1]).days <= 4:
                hs.append(h); keys.append(t)
        flat = [(t, h) for t, h in zip(keys, hs) for _ in range(paths)]
        res = []
        for i in range(0, len(flat), 256):
            ch = flat[i:i + 256]
            xs = [h["date"].reset_index(drop=True) for _, h in ch]
            ys = [pd.Series(pd.bdate_range(x.iloc[-1] + pd.Timedelta(days=1), periods=H)) for x in xs]
            res += pred.predict_batch([h[COLS].reset_index(drop=True) for _, h in ch], xs, ys, pred_len=H,
                                      sample_count=1, verbose=False)
        agg = {}
        for (t, h), q in zip(flat, res):
            p0 = float(h["close"].iloc[-1])                  # de-normalised paths can go ≤ 0 → floor at −95 %
            agg.setdefault(t, []).append(math.log(max(float(q["close"].iloc[-1]), 0.05 * p0) / p0))
        out[o] = {t: (float(np.mean(v)), float(np.std(v) + 1e-6)) for t, v in agg.items()}
        print(f"  origin {n + 1}/{len(origins)} {o.date()} · {len(keys)} names · {time.time() - t0:.0f}s", flush=True)
    return out


def spearman(a, b):
    return float(np.corrcoef(pd.Series(a).rank(), pd.Series(b).rank())[0, 1])


def main():
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    dfs = load_all()
    print(f"S184: {len(dfs)} names · {dev}", flush=True)
    spy = dfs.get("SPY")
    allm = sorted({d for g in dfs.values() for d in g["date"] if d > CUT and d.weekday() == 0})
    last_ok = max(g["date"].max() for g in dfs.values()) - pd.Timedelta(days=32)
    origins = [d for d in allm if d <= last_ok][::2]
    if FC.exists():
        F = pickle.load(open(FC, "rb"))
    else:
        tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base").to(dev).eval()
        if (SAVE / "config.json").exists() and "--retrain" not in sys.argv:
            ft = Kronos.from_pretrained(SAVE)
        else:
            tr, va = windows(dfs)
            print(f"train windows {len(tr)} · val {len(va)}", flush=True)
            ft = finetune(tok, Kronos.from_pretrained("NeoQuasar/Kronos-small").to(dev), tr, va, dev)
        tokp = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
        F = {"ft": forecast(KronosPredictor(ft, tokp, device=dev, max_context=512), dfs, origins, 8)}
        pickle.dump(F, open(FC, "wb"))
        F["zs"] = forecast(KronosPredictor(Kronos.from_pretrained("NeoQuasar/Kronos-small"), tokp, device=dev, max_context=512),
                           dfs, origins, 4)
        pickle.dump(F, open(FC, "wb"))

    # realized + comparators
    rows = []
    for o in origins:
        for t, g in dfs.items():
            if t not in F["ft"].get(o, {}):
                continue
            i = int((g["date"] <= o).sum()) - 1
            if i + H >= len(g) or i < 260:
                continue
            c = g["close"].values
            rows.append({"o": o, "t": t, "y": math.log(c[i + H] / c[i]), "rev": -math.log(c[i] / c[i - 20]),
                         "mom": math.log(c[i - 21] / c[i - 252]), "ft": F["ft"][o][t][0], "ft_sr": F["ft"][o][t][0] / F["ft"][o][t][1],
                         "zs": F.get("zs", {}).get(o, {}).get(t, (np.nan, 1))[0]})
    R = pd.DataFrame(rows)
    print(f"\n{len(R)} name-origins · {R['o'].nunique()} origins ({origins[0].date()}→{origins[-1].date()}) · "
          f"n_indep (non-overlapping 4-wk) ≈ {R['o'].nunique() // 2}")
    calls = pd.DataFrame([x for x in pickle.load(open(Path.home() / ".fildi/cache/s175_trades.pkl", "rb")) if x["s"] == "long_call"])
    calls["o"] = pd.to_datetime(calls["d"]); calls["r"] = calls["pnl"]            # S175 pnl is already per $ debit (−1 = total loss)
    for sig in ["ft", "ft_sr", "zs", "rev", "mom"]:
        if R[sig].isna().all():
            continue
        ic = R.dropna(subset=[sig]).groupby("o").apply(lambda g: spearman(g[sig], g["y"]))
        nov = ic.iloc[::2]                                   # every other biweekly origin = non-overlapping 21 sessions
        h1 = nov[nov.index < "2025-07-01"]; h2 = nov[nov.index >= "2025-07-01"]
        tt = lambda s: s.mean() / (s.std(ddof=1) / math.sqrt(len(s))) if len(s) > 2 else float("nan")
        q = R.dropna(subset=[sig]).copy()
        q["top"] = q.groupby("o")[sig].transform(lambda s: s >= s.quantile(0.8))
        q["bot"] = q.groupby("o")[sig].transform(lambda s: s <= s.quantile(0.2))
        ls = q.groupby("o").apply(lambda g: g.loc[g["top"], "y"].mean() - g.loc[g["bot"], "y"].mean()).iloc[::2]
        m = calls.merge(q[["o", "t", "top"]], on=["o", "t"])
        cd = m.groupby("o").apply(lambda g: g.loc[g["top"], "r"].mean() - g["r"].mean()).dropna()
        cd = cd.groupby(cd.index.to_period("M")).mean()
        print(f"  {sig:6s} IC {ic.mean():+.3f} · non-overlap t {tt(nov):+.2f} (n {len(nov)}) · halves {h1.mean():+.3f} / {h2.mean():+.3f} · "
              f"top−bottom fifth 21d {ls.mean():+.2%} · top-fifth calls − all calls {cd.mean():+.3f}/$ (month t {tt(cd):+.2f}, {len(cd)} mo)")
    R.to_pickle(Path.home() / ".fildi/cache/s184_scored.pkl")


if __name__ == "__main__":
    main()
