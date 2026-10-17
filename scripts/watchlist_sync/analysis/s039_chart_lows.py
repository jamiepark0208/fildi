#!/usr/bin/env python3
"""S039 L4 — can OpenJev spot short-term lows/highs from a chart? (Jamie 10-17)

Anonymous 60-day candle charts (no ticker, no dates, no axis numbers → the model cannot recall what happened next).
Questions read the image; answers graded on the next 10 sessions. Baseline: logistic model on RSI14, distance from the
20-day low/high, 5-day return, trained on the earlier half of dates. Test = later half. Calibration fit on train half.

    .venv/bin/python analysis/s039_chart_lows.py --prep      # sample + render PNGs (renders with the OpenJev venv's Pillow)
    .venv/bin/python analysis/s039_chart_lows.py --ask       # local OpenJev reads each chart
    .venv/bin/python analysis/s039_chart_lows.py --report
"""
from __future__ import annotations

import argparse
import base64
import json
import random
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "analysis"))
from build_plan import connect  # noqa: E402

DATA = ROOT / "research/openjev/charts"
N_BARS, FWD, N = 60, 10, 600
RENDER = r'''
import json, sys
from PIL import Image, ImageDraw
items = json.load(open(sys.argv[1]))
for it in items:
    o, h, l, c = (it[k] for k in ("o", "h", "l", "c"))
    W, H, pad = 480, 300, 10
    lo, hi = min(l), max(h)
    y = lambda v: pad + (H - 2 * pad) * (hi - v) / (hi - lo or 1)
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    bw = (W - 2 * pad) / len(c)
    for i in range(len(c)):
        x = pad + i * bw + bw / 2
        col = (22, 150, 80) if c[i] >= o[i] else (210, 50, 50)
        d.line([(x, y(h[i])), (x, y(l[i]))], fill=col, width=1)
        d.rectangle([x - bw * 0.35, min(y(o[i]), y(c[i])), x + bw * 0.35, max(y(o[i]), y(c[i])) + 1], fill=col)
    im.save(it["png"])
'''


def prep() -> None:
    conn = connect()
    DATA.mkdir(parents=True, exist_ok=True)
    with conn.cursor() as cur:
        cur.execute("select ticker, date::text, open, high, low, close from prices_historical where date >= '2025-07-01' order by ticker, date")
        px: dict = {}
        for t, d, o, h, l, c in cur.fetchall():
            if None not in (o, h, l, c):
                px.setdefault(t, []).append((d, float(o), float(h), float(l), float(c)))
    rnd = random.Random(17)
    cands = [(t, i) for t, rows in px.items() if t not in ("SPY", "QQQ") for i in range(N_BARS + 20, len(rows) - FWD, 15)]
    items = []
    for t, i in rnd.sample(cands, N):
        rows = px[t]
        win, fwd = rows[i - N_BARS + 1:i + 1], rows[i + 1:i + 1 + FWD]
        o, h, l, c = ([r[k] for r in win] for k in (1, 2, 3, 4))
        hist = [r[4] for r in rows[i - 80:i + 1]]
        d = np.diff(hist[-15:])
        rsi = 100 * d[d > 0].sum() / (np.abs(d).sum() or 1)
        items.append({"t": t, "date": win[-1][0], "png": str(DATA / f"{t}_{win[-1][0]}.png"), "o": o, "h": h, "l": l, "c": c,
                      "y_low_holds": min(r[3] for r in fwd) > l[-1], "y_high_holds": max(r[2] for r in fwd) < h[-1],
                      "y_up10": fwd[-1][4] > c[-1],
                      "x": [rsi, c[-1] / min(l[-20:]) - 1, c[-1] / max(h[-20:]) - 1, c[-1] / c[-6] - 1]})
    (DATA / "items.json").write_text(json.dumps(items))
    (DATA / "render.py").write_text(RENDER)
    subprocess.run([str(ROOT / "research/openjev/.venv/bin/python"), str(DATA / "render.py"), str(DATA / "items.json")], check=True)
    print(f"{len(items)} charts; base rates: low holds {np.mean([i['y_low_holds'] for i in items]):.2f}, "
          f"high holds {np.mean([i['y_high_holds'] for i in items]):.2f}, up in 10d {np.mean([i['y_up10'] for i in items]):.2f}")


QS = {"low_holds": "The last candle on the right is today. Over the next two weeks, will the price stay ABOVE today's low (today is at or near a short-term bottom)?",
      "high_holds": "The last candle on the right is today. Over the next two weeks, will the price stay BELOW today's high (today is at or near a short-term top)?",
      "up10": "The last candle on the right is today. Will the price be higher two weeks from now than today?"}


def ask() -> None:
    import openjev_local as oj
    items = json.loads((DATA / "items.json").read_text())
    out_f = DATA / "answers.jsonl"
    with oj.Server(), out_f.open("w") as w:
        for it in items:
            b64 = base64.b64encode(Path(it["png"]).read_bytes()).decode()
            body = {"model": oj.MODEL, "state": "Daily candlestick chart of a stock, last 60 trading days (green = up day, red = down day).",
                    "images": [f"data:image/png;base64,{b64}"],
                    "questions": {k: {"type": "noul", "instructions": q} for k, q in QS.items()}}
            a = oj._post("/v1/systemone", body)["answers"]
            w.write(json.dumps({"png": it["png"], **{k: a[k]["noul"] for k in QS}}) + "\n")


def report() -> None:
    from openjev_news import auc
    from s039_openjev_train import logreg, predict, brier
    items = {i["png"]: i for i in json.loads((DATA / "items.json").read_text())}
    rs = [{**items[r["png"]], **{"p_" + k: r[k] for k in QS}} for r in map(json.loads, (DATA / "answers.jsonl").open())]
    dates = sorted(r["date"] for r in rs)
    split = dates[len(dates) // 2]
    tr, te = [r for r in rs if r["date"] < split], [r for r in rs if r["date"] >= split]
    print(f"S039 L4: {len(rs)} anonymous charts; train < {split} ({len(tr)}), test ≥ {split} ({len(te)})")
    for k in QS:
        y_tr, y_te = np.array([r["y_" + k] for r in tr], float), np.array([r["y_" + k] for r in te], float)
        raw = np.array([r["p_" + k] for r in te])
        def fit(fn):
            Xtr, Xte = np.array([fn(r) for r in tr], float), np.array([fn(r) for r in te], float)
            mu, sd = Xtr.mean(0), Xtr.std(0) + 1e-9
            p = predict(logreg((Xtr - mu) / sd, y_tr), (Xte - mu) / sd)
            return auc(p, y_te), brier(p, y_te)
        a_cal, b_cal = fit(lambda r: [r["p_" + k]])
        a_b, b_b = fit(lambda r: r["x"])
        a_bo, b_bo = fit(lambda r: r["x"] + [r["p_" + k]])
        print(f"  {k:10s} base {y_te.mean():.2f} | OpenJev raw AUC {auc(raw, y_te):.3f} Brier {brier(raw, y_te):.3f} · calibrated Brier {b_cal:.3f}"
              f" | price-rule model AUC {a_b:.3f} Brier {b_b:.3f} | both AUC {a_bo:.3f} Brier {b_bo:.3f} | always-base Brier {brier(np.full(len(y_te), y_tr.mean()), y_te):.3f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--prep", action="store_true")
    ap.add_argument("--ask", action="store_true")
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()
    if a.prep:
        prep()
    if a.ask:
        ask()
    if a.report:
        report()
