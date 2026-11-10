"""S180 — Kronos (zero-shot, Kronos-small) as a cross-sectional long-call ranker, the way its paper/users apply it
(Jamie 11-09: "how are others using these tools"). Runs in ~/.fildi/kronos/venv (torch), repo at ~/.fildi/kronos/repo.

Kronos' predict()/predict_batch() AVERAGE the sampled paths (kronos.py auto_regressive_inference np.mean axis=1), so a
"32-sample" call returns one mean path. Here each series is fed N times with sample_count=1 → N independent paths.

Origins = S175 long-call Monday entries 2024-07-01→ (Kronos pretraining ends 2024-06 → earlier origins leak).
Per name × origin: 400 daily OHLCV bars ≤ entry → H = 22 sessions × N paths → terminal return r_i.
Outputs per trade: k_up = P(r > 0), k_mean = E[r], k_call = E[max(e^r − K/S, 0)] / debit − 1 (today's 0.50Δ strike and
debit from the cache: K/S = e^{½σ²T}, debit = capS), k_tail = P90 r, k_sd = path dispersion.
Graded in the S179 harness: weekly top-fifth mean pnl per $ debit vs the S177 ramp score (production) and all calls;
Brier of k_up vs realized up. Pre-registered pass: k_call (or k_up) top fifth > production top fifth, month-block t ≥ 2,
same sign in both halves of the window (2024-07→2025-06, 2025-07→); Brier skill > 0 vs 0.5/base. n_indep = weeks.
Usage: python s180_kronos_calls.py [--smoke] [--paths 32]   (smoke = 20 names × 1 origin, timing only)
"""
from __future__ import annotations

import math
import pickle
import sys
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg

sys.path.insert(0, str(Path.home() / ".fildi/kronos/repo"))
from model import Kronos, KronosPredictor, KronosTokenizer  # noqa: E402

CACHE = Path.home() / ".fildi/cache/s175_trades.pkl"
OUT = Path.home() / ".fildi/cache/s180_kronos.pkl"
START = date(2024, 7, 1)
LOOK, H = 400, 22
N = int(sys.argv[sys.argv.index("--paths") + 1]) if "--paths" in sys.argv else 32
SMOKE = "--smoke" in sys.argv


def dsn():
    root = Path(__file__).resolve().parents[3]   # same ROOT as build_plan_parts/db.py
    for p in (root / ".env.local", root / ".env"):
        if p.is_file():
            for line in p.read_text().splitlines():
                if line.startswith("DATABASE_URL="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("DATABASE_URL not in .env.local/.env")


def main():
    T = [x for x in pickle.loads(CACHE.read_bytes()) if x["s"] == "long_call" and x["d"] >= START]
    done = pickle.loads(OUT.read_bytes()) if OUT.exists() and not SMOKE else {}
    names = sorted({x["t"] for x in T})
    bars = defaultdict(list)
    with psycopg.connect(dsn()) as conn:
        for t, d, o, h, l, c, v in conn.execute("""SELECT ticker, date, open, high, low, close, volume FROM lseg_research.daily_history
                    WHERE ticker = ANY(%s) AND date >= '2022-06-01' AND close > 0 AND open > 0 AND high > 0 AND low > 0
                    ORDER BY ticker, date""", (names,)):
            bars[t].append((d, o, h, l, c, v or 0.0))
    iv = {}
    with psycopg.connect(dsn()) as conn:
        for t, d, i in conn.execute("""SELECT ticker, date, iv30_call FROM lseg_research.daily_history
                    WHERE ticker = ANY(%s) AND date >= %s AND iv30_call > 0""", (names, START - timedelta(days=7))):
            iv[(t, d)] = i / 100
    tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    mdl = Kronos.from_pretrained("NeoQuasar/Kronos-small")
    pred = KronosPredictor(mdl, tok, max_context=512)
    print(f"device {pred.device} · paths {N} · trades {len(T)} · done {len(done)}")
    by_w = defaultdict(list)
    for x in T:
        by_w[x["d"]].append(x)
    weeks = sorted(by_w)[:1] if SMOKE else sorted(by_w)
    t0 = time.time()
    for wi, w in enumerate(weeks):
        todo = []
        for x in by_w[w]:
            if (x["t"], w) in done:
                continue
            b = [r for r in bars.get(x["t"], []) if r[0] <= w]
            if len(b) < LOOK:
                continue
            b = b[-LOOK:]
            ivx = next((iv[(x["t"], b[-1][0] - timedelta(days=k))] for k in range(5) if (x["t"], b[-1][0] - timedelta(days=k)) in iv), None)
            if not ivx:
                continue
            todo.append((x, b, ivx))
        if SMOKE:
            todo = todo[:20]
        for x, b, ivx in todo:
            df = pd.DataFrame(b, columns=["date", "open", "high", "low", "close", "volume"])
            df["amount"] = df["close"] * df["volume"]
            xs = pd.Series(pd.to_datetime(df["date"]))
            ys = pd.Series(pd.bdate_range(xs.iloc[-1] + pd.Timedelta(days=1), periods=H))
            outs = pred.predict_batch([df[["open", "high", "low", "close", "volume", "amount"]]] * N, [xs] * N, [ys] * N,
                                      pred_len=H, T=1.0, top_p=0.9, sample_count=1, verbose=False)
            r = np.log(np.array([o["close"].iloc[-1] for o in outs]) / b[-1][4])
            Ty = x["days"] / 365
            kx = math.exp(0.5 * ivx ** 2 * Ty)
            pay = np.maximum(np.exp(r) - kx, 0) / x["capS"] - 1
            done[(x["t"], w)] = {"k_up": float((r > 0).mean()), "k_mean": float(r.mean()), "k_call": float(pay.mean()),
                                 "k_tail": float(np.percentile(r, 90)), "k_sd": float(r.std()), "pnl": x["pnl"], "w": w, "t": x["t"]}
        if not SMOKE:
            OUT.write_bytes(pickle.dumps(done))
        el = time.time() - t0
        print(f"week {w} ({wi + 1}/{len(weeks)}) +{len(todo)} · {el / 60:.1f} min · {el / max(sum(1 for v in done.values()), 1):.2f} s/name")
    if SMOKE:
        for k, v in list(done.items())[:20]:
            print(k, {a: round(b, 3) for a, b in v.items() if isinstance(b, float)})


if __name__ == "__main__":
    main()
