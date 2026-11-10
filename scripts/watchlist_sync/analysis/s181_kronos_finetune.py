"""S181 — one-ticker Kronos fine-tune probe (Jamie 11-10: "we have candles — small test on 1 ticker").
Runs in ~/.fildi/kronos/venv. Predictor only (pretrained tokenizer frozen), Mac MPS.

S180 found zero-shot daily forecasts pull to the lookback mean. Suspected cause: the repo's fine-tune dataset
(finetune_csv/finetune_base_model.py __getitem__) z-scores each window over lookback+future, so the future always sits
inside the window's range. Here windows are z-scored on the LOOKBACK only — the same stats inference uses.

Train: SPY daily ≤ 2024-06-28 (Kronos pretrain cutoff), window 400 + 22, last 15 % of train = validation.
Test: SPY weekly origins 2024-07-01 → (22-session horizon; n_indep ≈ weeks/4.4 — mechanics test, not an edge test).
Per origin, zero-shot vs fine-tuned, 16 real paths each (N× batch, sample_count=1): mean 22-d log return, P(up).
Metrics: bias (mean pred − mean actual), RMSE vs naive 0, corr(pred, actual), Brier of P(up) vs 0.5 and base rate.
Pass (mechanics): fine-tuned |bias| < half of zero-shot's AND RMSE ≤ naive AND P(up) not degenerate (share of origins
with 0 < P < 1 ≥ 50 %). Edge needs the cross-section (S180) — only if mechanics pass.
"""
from __future__ import annotations

import math
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

T = sys.argv[sys.argv.index("--ticker") + 1] if "--ticker" in sys.argv else "SPY"
LOOK, H, PATHS = 400, 22, 16
CUT = pd.Timestamp("2024-06-28")
EPOCHS = int(sys.argv[sys.argv.index("--epochs") + 1]) if "--epochs" in sys.argv else 3
LR = 2e-5
SAVE = Path.home() / f".fildi/kronos/finetuned/{T}_lookbacknorm"
COLS = ["open", "high", "low", "close", "volume", "amount"]


def stamps(ts: pd.Series) -> np.ndarray:
    return np.stack([ts.dt.minute, ts.dt.hour, ts.dt.weekday, ts.dt.day, ts.dt.month], 1).astype(np.float32)


def load() -> pd.DataFrame:
    with psycopg.connect(dsn()) as c:
        r = c.execute("""SELECT date, open, high, low, close, volume FROM lseg_research.daily_history WHERE ticker = %s
                         AND close > 0 AND open > 0 AND high > 0 AND low > 0 ORDER BY date""", (T,)).fetchall()
    df = pd.DataFrame(r, columns=["date", "open", "high", "low", "close", "volume"])
    df["date"] = pd.to_datetime(df["date"]); df["volume"] = df["volume"].fillna(0).astype(float)
    df["amount"] = df["close"] * df["volume"]
    return df


def windows(df: pd.DataFrame):
    x, s = df[COLS].values.astype(np.float32), stamps(df["date"])
    out = []
    for i in range(0, len(df) - LOOK - H + 1):
        w = x[i:i + LOOK + H]
        mu, sd = w[:LOOK].mean(0), w[:LOOK].std(0)          # lookback-only stats (= inference)
        out.append((np.clip((w - mu) / (sd + 1e-5), -5, 5), s[i:i + LOOK + H]))
    return out


def finetune(tok, mdl, train, val, dev):
    opt = torch.optim.AdamW(mdl.parameters(), lr=LR, betas=(0.9, 0.95), weight_decay=0.1)
    rng = np.random.default_rng(181)

    def batches(ws, shuffle):
        idx = rng.permutation(len(ws)) if shuffle else np.arange(len(ws))
        for b in range(0, len(idx), 16):
            sel = [ws[k] for k in idx[b:b + 16]]
            yield (torch.tensor(np.stack([a for a, _ in sel])).to(dev), torch.tensor(np.stack([z for _, z in sel])).to(dev))

    def loss_on(bx, bs):
        with torch.no_grad():
            t0, t1 = tok.encode(bx, half=True)
        lg = mdl(t0[:, :-1], t1[:, :-1], bs[:, :-1, :])
        return mdl.head.compute_loss(lg[0], lg[1], t0[:, 1:], t1[:, 1:])[0]

    best = math.inf
    for ep in range(EPOCHS):
        mdl.train(); tl = []
        for bx, bs in batches(train, True):
            loss = loss_on(bx, bs); opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(mdl.parameters(), 3.0); opt.step(); tl.append(loss.item())
        mdl.eval()
        with torch.no_grad():
            vl = float(np.mean([loss_on(bx, bs).item() for bx, bs in batches(val, False)]))
        print(f"epoch {ep + 1}/{EPOCHS} train {np.mean(tl):.4f} val {vl:.4f}")
        if vl < best:
            best = vl; SAVE.mkdir(parents=True, exist_ok=True); mdl.save_pretrained(SAVE)
    return Kronos.from_pretrained(SAVE)


def forecast(pred, df, origins):
    out = []
    for o in origins:
        h = df[df["date"] <= o].iloc[-LOOK:]
        fut = df[df["date"] > o].iloc[:H]
        if len(h) < LOOK or len(fut) < H:
            continue
        xs = h["date"].reset_index(drop=True)
        ys = pd.Series(pd.bdate_range(xs.iloc[-1] + pd.Timedelta(days=1), periods=H))
        res = pred.predict_batch([h[COLS].reset_index(drop=True)] * PATHS, [xs] * PATHS, [ys] * PATHS,
                                 pred_len=H, sample_count=1, verbose=False)
        r = np.log(np.array([q["close"].iloc[-1] for q in res]) / h["close"].iloc[-1])
        out.append((o, r.mean(), (r > 0).mean(), math.log(fut["close"].iloc[-1] / h["close"].iloc[-1])))
    return out


def report(name, rows, base):
    p = np.array([r[1] for r in rows]); u = np.array([r[2] for r in rows]); a = np.array([r[3] for r in rows])
    y = (a > 0).astype(float)
    rm, rn = math.sqrt(((p - a) ** 2).mean()), math.sqrt((a ** 2).mean())
    b, b5, bb = ((u - y) ** 2).mean(), ((0.5 - y) ** 2).mean(), ((base - y) ** 2).mean()
    nd = ((u > 0) & (u < 1)).mean()
    print(f"{name:11s} n {len(rows)} · mean pred {p.mean():+.4f} vs actual {a.mean():+.4f} (bias {p.mean() - a.mean():+.4f}) · "
          f"RMSE {rm:.4f} vs naive {rn:.4f} · corr {np.corrcoef(p, a)[0, 1]:+.2f} · dir hit {((p > 0) == (a > 0)).mean():.2f} · "
          f"Brier {b:.3f} vs 0.5 {b5:.3f} / base {bb:.3f} · P(up) non-degenerate {nd:.0%}")
    return p.mean() - a.mean(), rm, rn, nd


def main():
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    df = load()
    tr = df[df["date"] <= CUT].reset_index(drop=True)
    ws = windows(tr); k = int(len(ws) * 0.85)
    print(f"S181 {T}: {len(df)} bars {df['date'].iloc[0].date()}→{df['date'].iloc[-1].date()} · train windows {k} · val {len(ws) - k} · {dev}")
    tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base").to(dev).eval()
    base_m = Kronos.from_pretrained("NeoQuasar/Kronos-small")
    t0 = time.time()
    ft_m = finetune(tok, Kronos.from_pretrained("NeoQuasar/Kronos-small").to(dev), ws[:k], ws[k:], dev)
    print(f"fine-tune {(time.time() - t0) / 60:.1f} min → {SAVE}")
    origins = [d for d in df["date"] if d > CUT and d.weekday() == 0]
    base_up = float((np.log(tr["close"].shift(-H) / tr["close"]).dropna() > 0).mean())
    tok_cpu = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    zs = forecast(KronosPredictor(base_m, tok_cpu, max_context=512), df, origins)
    ft = forecast(KronosPredictor(ft_m, tok_cpu, max_context=512), df, origins)
    print(f"test origins {origins[0].date()}→{origins[-1].date()} · horizon {H} sessions · n_indep ≈ {len(zs) / 4.4:.0f} · train base P(up) {base_up:.2f}")
    bz = report("zero-shot", zs, base_up)
    bf = report("fine-tuned", ft, base_up)
    ok = abs(bf[0]) < abs(bz[0]) / 2 and bf[1] <= bf[2] and bf[3] >= 0.5
    print(f"mechanics pass: {ok} (bias halved {abs(bf[0]) < abs(bz[0]) / 2}, RMSE ≤ naive {bf[1] <= bf[2]}, P(up) spread {bf[3] >= 0.5})")


if __name__ == "__main__":
    main()
