#!/usr/bin/env python3
"""S040 — can OpenJev pick support levels that hold? (Jamie 10-18)

Anonymous 120-day candle charts. Candidates below price: up to 4 swing-low clusters (5-bar pivots within 1.5 %) + 2 random decoy
levels in the same band, shuffled and lettered on the chart. OpenJev: choice "which line is the strongest support?" (2 reads,
shuffled letters). Outcome per level over the next 20 sessions: touched = low ≤ level × 1.005; held = no close < level × 0.98
within 5 sessions after the first touch. Compares hold rates (touched levels only): OpenJev's pick, the rule pick (most pivot
touches), algorithm levels vs decoys (does S/R exist at all here?), and AUC of OpenJev's probability vs touch count.

    .venv/bin/python analysis/s040_sr_levels.py --prep | --ask | --report
"""
from __future__ import annotations

import argparse
import base64
import json
import random
import string
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

DATA = ROOT / "research/openjev/sr"
N, BARS, FWD = 300, 120, 20
RENDER = r'''
import json, sys
from PIL import Image, ImageDraw
for it in json.load(open(sys.argv[1])):
    o, h, l, c = (it[k] for k in ("o", "h", "l", "c"))
    W, H, pad = 560, 340, 12
    lo, hi = min(l + [x["level"] for x in it["cands"]]), max(h)
    y = lambda v: pad + (H - 2 * pad) * (hi - v) / (hi - lo or 1)
    im = Image.new("RGB", (W, H), "white"); d = ImageDraw.Draw(im)
    bw = (W - 2 * pad - 24) / len(c)
    for i in range(len(c)):
        x = pad + i * bw + bw / 2
        col = (22, 150, 80) if c[i] >= o[i] else (210, 50, 50)
        d.line([(x, y(h[i])), (x, y(l[i]))], fill=col, width=1)
        d.rectangle([x - bw * .35, min(y(o[i]), y(c[i])), x + bw * .35, max(y(o[i]), y(c[i])) + 1], fill=col)
    prev, xoff = None, 0
    for cand in sorted(it["cands"], key=lambda z: -z["level"]):
        yy = y(cand["level"])
        xoff = xoff + 12 if prev is not None and abs(yy - prev) < 12 else 0
        prev = yy
        for x0 in range(pad, W - 30, 10):
            d.line([(x0, yy), (x0 + 5, yy)], fill=(40, 90, 220), width=1)
        d.text((W - 14 - xoff, yy - 6), cand["letter"], fill=(40, 90, 220))
    im.save(it["png"])
'''


def pivots(lows: list[float], k: int = 5) -> list[float]:
    return [lows[i] for i in range(k, len(lows) - k) if lows[i] == min(lows[i - k:i + k + 1])]


def clusters(ps: list[float], tol: float = 0.015) -> list[tuple[float, int]]:
    out: list[list[float]] = []
    for p in sorted(ps):
        if out and p <= out[-1][0] * (1 + tol):
            out[-1].append(p)
        else:
            out.append([p])
    return [(sum(g) / len(g), len(g)) for g in out]


def prep() -> None:
    conn = connect()
    DATA.mkdir(parents=True, exist_ok=True)
    with conn.cursor() as cur:
        cur.execute("select ticker, date::text, open, high, low, close from prices_historical where date >= '2025-04-01' order by ticker, date")
        px: dict = {}
        for t, d, o, h, l, c in cur.fetchall():
            if None not in (o, h, l, c):
                px.setdefault(t, []).append((d, float(o), float(h), float(l), float(c)))
    rnd = random.Random(40)
    cands = [(t, i) for t, rows in px.items() if t not in ("SPY", "QQQ") for i in range(BARS + 5, len(rows) - FWD, 20)]
    items = []
    for t, i in rnd.sample(cands, len(cands)):
        if len(items) >= N:
            break
        rows = px[t]
        win, fwd = rows[i - BARS + 1:i + 1], rows[i + 1:i + 1 + FWD]
        o, h, l, c = ([r[k] for r in win] for k in (1, 2, 3, 4))
        price = c[-1]
        lv = [(lev, n) for lev, n in clusters(pivots(l)) if price * 0.85 <= lev < price * 0.995]
        lv = sorted(lv, key=lambda z: -z[0])[:4]
        if len(lv) < 2:
            continue
        band = (price * 0.85, price * 0.995)
        decoys = [(rnd.uniform(*band), 0) for _ in range(2)]
        levels = [{"level": a, "touches": n, "algo": n > 0} for a, n in lv + decoys]
        rnd.shuffle(levels)
        for k, lvl in zip(string.ascii_uppercase, levels):
            lvl["letter"] = k
            touch = next((j for j, r in enumerate(fwd) if r[3] <= lvl["level"] * 1.005), None)
            lvl["touched"] = touch is not None
            lvl["held"] = touch is not None and all(r[4] >= lvl["level"] * 0.98 for r in fwd[touch:touch + 5])
        items.append({"t": t, "date": win[-1][0], "png": str(DATA / f"{t}_{win[-1][0]}.png"), "o": o, "h": h, "l": l, "c": c, "cands": levels})
    (DATA / "items.json").write_text(json.dumps(items))
    (DATA / "render.py").write_text(RENDER)
    subprocess.run([str(ROOT / "research/openjev/.venv/bin/python"), str(DATA / "render.py"), str(DATA / "items.json")], check=True)
    lv = [x for it in items for x in it["cands"]]
    tch = [x for x in lv if x["touched"]]
    print(f"{len(items)} charts, {len(lv)} levels, {len(tch)} touched in the next {FWD} sessions; hold rate algo "
          f"{sum(x['held'] for x in tch if x['algo']) / max(1, sum(x['algo'] for x in tch)):.2f} vs decoys "
          f"{sum(x['held'] for x in tch if not x['algo']) / max(1, sum(not x['algo'] for x in tch)):.2f}")


def ask() -> None:
    import openjev_local as oj
    items = json.loads((DATA / "items.json").read_text())
    out = DATA / "answers.jsonl"
    with oj.Server(), out.open("w") as w:
        for it in items:
            b64 = base64.b64encode(Path(it["png"]).read_bytes()).decode()
            probs: dict = {}
            for seed in (1, 2):
                letters = [x["letter"] for x in it["cands"]]
                random.Random(seed).shuffle(letters)
                q = {"s": {"type": "choice", "instructions": "The blue dashed lines (letters on the right) are possible support levels below "
                           "today's price (last candle). Which line is the strongest support, most likely to hold if price falls to it?",
                           "criteria": {k: f"line {k}" for k in letters}}}
                a = oj._post("/v1/systemone", {"model": oj.MODEL, "state": "Daily candlestick chart of a stock, last 120 trading days.",
                                               "images": [f"data:image/png;base64,{b64}"], "questions": q})["answers"]["s"]
                for k, v in (a.get("probabilities") or {}).items():
                    probs[k] = probs.get(k, 0) + v / 2
            w.write(json.dumps({"png": it["png"], "p": probs}) + "\n")


def report() -> None:
    from openjev_news import auc
    items = {i["png"]: i for i in json.loads((DATA / "items.json").read_text())}
    ans = [json.loads(x) for x in (DATA / "answers.jsonl").open()]
    rows, picks = [], {"openjev": [], "rule": [], "random": []}
    rnd = random.Random(1)
    for a in ans:
        it = items[a["png"]]
        for x in it["cands"]:
            rows.append({**x, "p": a["p"].get(x["letter"], 0)})
        top = max(it["cands"], key=lambda x: a["p"].get(x["letter"], 0))
        rule = max(it["cands"], key=lambda x: (x["touches"], x["level"]))
        for name, x in (("openjev", top), ("rule", rule), ("random", rnd.choice(it["cands"]))):
            if x["touched"]:
                picks[name].append(x["held"])
    tch = [r for r in rows if r["touched"]]
    print(f"S040: {len(ans)} charts, {len(tch)} touched levels")
    for k, v in picks.items():
        print(f"  {k:8s} pick: touched {len(v)}, held {sum(v)}/{len(v)} = {sum(v) / max(1, len(v)):.2f}")
    print(f"  algorithm levels hold {sum(r['held'] for r in tch if r['algo'])}/{sum(r['algo'] for r in tch)} vs decoys "
          f"{sum(r['held'] for r in tch if not r['algo'])}/{sum(not r['algo'] for r in tch)}")
    y = [r["held"] for r in tch]
    print(f"  AUC for 'held' among touched levels: OpenJev P {auc([r['p'] for r in tch], y):.3f} · touch count {auc([r['touches'] for r in tch], y):.3f}"
          f" · distance below price {auc([-r['level'] for r in tch], y):.3f}")
    print(f"  OpenJev picks a decoy {sum(1 for a in ans if not max(items[a['png']]['cands'], key=lambda x: a['p'].get(x['letter'], 0))['algo'])}/{len(ans)} times (random ≈ 33 %)")


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
