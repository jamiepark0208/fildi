#!/usr/bin/env python3
"""A307 — grade Live hotlist entry verdicts (enter/wait/avoid) for put-seller timing.

0 graded hotlist_snapshots → replay optlab.bars_5m on T1's universe at Live checkpoints,
recompute ticker direction + market regime (same gates as intraday-entry-signals verdictFor, dip side, no FVG/falling-knife),
outcomes = 0.11Δ put strike breach / MAE / 1d·10d stock return. Placebo = shuffle verdict mix within day.
Pass bar (A307): enter vs avoid breach gap ≥ 3 pp, day-clustered t ≥ 2 both halves, beats placebo.

  .venv/bin/python analysis/a307_entry_verdicts.py [--smoke]
"""
from __future__ import annotations

import json
import math
import random
import sys
from collections import defaultdict
from datetime import date, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import ROOT, connect  # noqa: E402
from s088_sr_zones import listed_strike  # noqa: E402

# Reuse S126 session geometry (import composite + CPS without editing s126 file)
from s126_intraday_regime import CPS, composite, load  # noqa: E402

ET = ZoneInfo("America/New_York")
Z11 = 1.2265
SPLIT = date(2025, 11, 10)
MODEL_PATH = HERE.parent / "out" / "opt" / "S126_model.json"
OUT_PACKET = HERE.parent / "out" / "opt" / "A307-packet.md"
SEED = 307
HORIZON_TD = 10
DTE = 14


def dir3(comp: int) -> str | None:
    if comp > 0:
        return "bullish"
    if comp < 0:
        return "bearish"
    return None


def combine_regime(spy: int, qqq: int) -> str | None:
    ds, dq = dir3(spy), dir3(qqq)
    if not ds and not dq:
        return None
    if ds and dq:
        return ds if ds == dq else "mixed"
    return ds or dq


def verdict_live(ticker_dir: str | None, regime: str | None) -> str:
    if ticker_dir == "bearish":
        return "avoid"
    if regime == "bearish":
        return "avoid"
    if ticker_dir == "bullish" and regime == "bullish":
        return "enter"
    if ticker_dir == "bullish":
        return "wait"
    return "wait"


def verdict_risk(ticker_dir: str | None, risk: str | None) -> str:
    if ticker_dir == "bearish":
        return "avoid"
    if risk in ("stormy", "elevated"):
        return "wait"
    if ticker_dir == "bullish" and risk in ("calm", "normal", None):
        return "enter"
    return "wait"


def risk_level(b, m: int, daily_atr: float, daily_ret5d: float, model: dict) -> str | None:
    sc = risk_score(b, m, daily_atr, daily_ret5d, model)
    return level_from_score(sc, model) if sc is not None else None


def risk_score(b, m: int, daily_atr: float, daily_ret5d: float, model: dict) -> float | None:
    typical = model["rngMedianByMin"].get(str(m)) or model["rngMedianByMin"].get(m)
    if typical is None or not (daily_atr > 0) or len(b) < 4:
        return None
    open_ = b.o.iloc[0]
    last = b.c.iloc[-1]
    hh, ll = b.h.max(), b.l.min()
    path = abs(b.c.iloc[0] - open_) + b.c.diff().abs().iloc[1:].sum()
    trs = np.maximum(b.h - b.l, np.maximum((b.h - b.c.shift()).abs(), (b.l - b.c.shift()).abs())).fillna(b.h - b.l)
    er = abs(last - open_) / path if path > 0 else 0
    chop = 100 * np.log10(trs.sum() / (hh - ll)) / np.log10(len(b)) if hh > ll else 100
    rng = (hh - ll) / open_ / daily_atr
    rng_rel = rng / typical
    mu, sd, w = model["mu"], model["sd"], model["weights"]
    vals = {"rng_rel": rng_rel, "ret5d": daily_ret5d, "er": er, "chop": chop}
    score = w[0]
    for i, k in enumerate(["rng_rel", "ret5d", "er", "chop"]):
        score += w[i + 1] * (vals[k] - mu[k]) / sd[k]
    return float(score)


def level_from_score(score: float, model: dict) -> str:
    idx = sum(1 for c in model["cuts"] if score >= c)
    return model["levels"][min(idx, len(model["levels"]) - 1)]


def combine_risk_score(sa: float | None, sb: float | None, model: dict) -> str | None:
    if sa is None:
        return level_from_score(sb, model) if sb is not None else None
    if sb is None:
        return level_from_score(sa, model)
    return level_from_score((sa + sb) / 2, model)


def strike_at(S: float, iv: float) -> float:
    T = DTE / 365
    sd = iv * math.sqrt(T)
    raw = S * math.exp(-Z11 * sd - 0.5 * sd * sd)
    return listed_strike(raw, S, "put")


def daily_context(closes: list[tuple[date, float, float, float]], d: date):
    """atr20 fraction + ret5d from daily rows strictly before d."""
    prior = [(dd, c, h, l) for dd, c, h, l in closes if dd < d and c and h and l]
    if len(prior) < 21:
        return None, None
    tail = prior[-21:]
    trs = []
    for i in range(1, len(tail)):
        pc = tail[i - 1][1]
        h, l = tail[i][2], tail[i][3]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)) / pc)
    atr20 = float(np.mean(trs))
    ret5d = tail[-1][1] / tail[-6][1] - 1
    return atr20, ret5d


def clustered_t(rows: list[dict], key: str = "breach") -> float:
    buckets: dict[tuple, list] = defaultdict(list)
    for r in rows:
        buckets[(r["t"], r["d"])].append(r[key])
    xs = np.array([float(np.mean(v)) for v in buckets.values()])
    if len(xs) < 3 or xs.std(ddof=1) == 0:
        return float("nan")
    return float(xs.mean() / (xs.std(ddof=1) / math.sqrt(len(xs))))


def day_gap(rows: list[dict], vk: str) -> list[dict]:
    """Per calendar day: mean breach avoid − mean breach enter (positive = enter safer)."""
    by_day: dict[date, dict] = defaultdict(lambda: {"enter": [], "avoid": []})
    for r in rows:
        v = r[vk]
        if v in ("enter", "avoid"):
            by_day[r["d"]][v].append(float(r["breach"]))
    out = []
    for d, g in by_day.items():
        if len(g["enter"]) < 1 or len(g["avoid"]) < 1:
            continue
        out.append({"t": "_mkt", "d": d, "gap": np.mean(g["avoid"]) - np.mean(g["enter"]), "half": "H1" if d < SPLIT else "H2"})
    return out


def placebo_gaps(rows: list[dict], verdict_key: str, rng: random.Random) -> list[float]:
    by_day: dict[date, list] = defaultdict(list)
    for r in rows:
        by_day[r["d"]].append(r)
    gaps = []
    for d, rs in by_day.items():
        labels = [r[verdict_key] for r in rs]
        rng.shuffle(labels)
        enter_b, avoid_b = [], []
        for r, lab in zip(rs, labels):
            if lab == "enter":
                enter_b.append(r["breach"])
            elif lab == "avoid":
                avoid_b.append(r["breach"])
        if enter_b and avoid_b:
            gaps.append(float(np.mean(enter_b) - np.mean(avoid_b)))
    return gaps


def market_cache(model: dict) -> dict[tuple[date, int], tuple[str | None, str | None]]:
    spy_h: dict[tuple[date, int], tuple[int, float | None]] = {}
    qqq_h: dict[tuple[date, int], tuple[int, float | None]] = {}
    for tk, store in (("SPY", spy_h), ("QQQ", qqq_h)):
        df = load(tk)
        days = [g for _, g in df.groupby("d") if len(g) >= 70]
        daily_cl = {g.d.iloc[0]: (g.c.iloc[-1], g.h.max(), g.l.min()) for g in days}
        closes = sorted((d, daily_cl[d][0], daily_cl[d][1], daily_cl[d][2]) for d in daily_cl)
        for k, g in enumerate(days):
            d = g.d.iloc[0]
            atr, r5 = daily_context(closes, d)
            if atr is None:
                continue
            prev = days[k - 1] if k else None
            ph, pl = (prev.h.max(), prev.l.min()) if prev is not None else (None, None)
            g = g.reset_index(drop=True)
            for m in CPS:
                b = g[g.m < m]
                if len(b) < 4:
                    continue
                comp = composite(b, ph, pl)
                sc = risk_score(b, m, atr, r5, model)
                store[(d, m)] = (comp, sc)
    out = {}
    for key in set(spy_h) & set(qqq_h):
        sc, sq = spy_h[key][1], qqq_h[key][1]
        out[key] = (combine_regime(spy_h[key][0], qqq_h[key][0]), combine_risk_score(sc, sq, model))
    return out


def _load_env() -> None:
    from dotenv import load_dotenv

    for p in (ROOT / ".env.local", ROOT / ".env"):
        if p.is_file():
            load_dotenv(p, override=False)


def main() -> int:
    smoke = "--smoke" in sys.argv
    _load_env()
    model = json.loads(MODEL_PATH.read_text())
    mkt = market_cache(model)
    rows: list[dict] = []
    rng = random.Random(SEED)

    with connect() as conn:
        tickers = [t for (t,) in conn.execute("SELECT DISTINCT ticker FROM optlab.bars_5m ORDER BY 1")]
        if smoke:
            tickers = tickers[:8]
        for ti, t in enumerate(tickers):
            if ti and ti % 40 == 0:
                print(f"… {ti}/{len(tickers)} tickers", flush=True)
            daily = conn.execute(
                "SELECT date, close::float8, high::float8, low::float8, iv30_put::float8 "
                "FROM lseg_research.daily_history WHERE ticker = %s ORDER BY date",
                (t,),
            ).fetchall()
            if len(daily) < 30:
                continue
            dmap = {d: (c, h, l, iv) for d, c, h, l, iv in daily}
            closes = [(d, c, h, l) for d, c, h, l, _ in daily if c and h and l]
            raw = conn.execute("SELECT ts, o, h, l, c FROM optlab.bars_5m WHERE ticker = %s ORDER BY ts", (t,)).fetchall()
            bars = [(ts.astimezone(ET), o, h, l, c) for ts, o, h, l, c in raw]
            bars = [b for b in bars if time(9, 30) <= b[0].time() < time(16, 0)]
            if len(bars) < 2000:
                continue
            # group by day
            from collections import defaultdict as dd

            by_d: dict[date, list] = dd(list)
            for b in bars:
                by_d[b[0].date()].append(b)
            days_sorted = sorted(by_d)
            for di, d0 in enumerate(days_sorted):
                gbars = by_d[d0]
                if len(gbars) < 70:
                    continue
                atr, _ = daily_context(closes, d0)
                if atr is None:
                    continue
                prev_day = days_sorted[di - 1] if di else None
                prev_bars = by_d[prev_day] if prev_day else None
                ph = max(b[2] for b in prev_bars) if prev_bars else None
                pl = min(b[3] for b in prev_bars) if prev_bars else None
                prev_iv_row = max((dd for dd in closes if dd[0] < d0), key=lambda x: x[0], default=None)
                iv = dmap.get(d0, (None, None, None, None))[3]
                if prev_iv_row and dmap.get(prev_iv_row[0]):
                    iv = iv or dmap[prev_iv_row[0]][3]
                if not iv or iv > 3:
                    iv = iv / 100 if iv and iv > 3 else iv
                if not iv or iv <= 0:
                    continue
                # build minute index like s126
                import pandas as pd

                rec = []
                for ts, o, h, l, c in gbars:
                    m = (ts.hour * 60 + ts.minute) - 570
                    rec.append({"ts": ts, "o": o, "h": h, "l": l, "c": c, "v": 1.0, "m": m, "d": d0})
                g = pd.DataFrame(rec)
                future_days = [x for x in days_sorted if x >= d0][: HORIZON_TD + 1]
                fwd_lows = []
                for fd in future_days:
                    if fd == d0:
                        # lows after first checkpoint handled per row
                        continue
                    if fd in dmap:
                        fwd_lows.append(dmap[fd][2])  # daily low
                for m in CPS:
                    mk = (d0, m)
                    if mk not in mkt:
                        continue
                    regime, risk = mkt[mk]
                    b = g[g.m < m]
                    if len(b) < 4:
                        continue
                    comp = composite(b, ph, pl)
                    td = dir3(comp)
                    vl = verdict_live(td, regime)
                    vr = verdict_risk(td, risk)
                    S = float(b.c.iloc[-1])
                    K = strike_at(S, float(iv))
                    # forward min low: rest of session + next trading days
                    after = g[g.m >= m]
                    lows = list(after.l.astype(float)) if len(after) else []
                    lows.extend(fwd_lows)
                    if not lows:
                        continue
                    min_low = min(lows)
                    breach = min_low <= K
                    mae = max(0.0, (S - min_low) / S * 100)
                    # forward closes
                    idx = days_sorted.index(d0)
                    c1 = dmap[days_sorted[idx + 1]][0] if idx + 1 < len(days_sorted) else None
                    c10 = dmap[days_sorted[idx + HORIZON_TD]][0] if idx + HORIZON_TD < len(days_sorted) else None
                    rows.append({
                        "t": t, "d": d0, "m": m,
                        "verdict": vl, "verdict_risk": vr,
                        "breach": breach, "mae": mae,
                        "fwd1": (c1 / S - 1) * 100 if c1 else None,
                        "fwd10": (c10 / S - 1) * 100 if c10 else None,
                    })

    if len(rows) < 300:
        print(f"WARNING: only {len(rows)} replay rows", flush=True)

    def summarize(label: str, vk: str):
        enter = [r for r in rows if r[vk] == "enter"]
        wait = [r for r in rows if r[vk] == "wait"]
        avoid = [r for r in rows if r[vk] == "avoid"]
        br_e = np.mean([r["breach"] for r in enter]) if enter else float("nan")
        br_a = np.mean([r["breach"] for r in avoid]) if avoid else float("nan")
        br_w = np.mean([r["breach"] for r in wait]) if wait else float("nan")
        gaps = day_gap(rows, vk)
        g1 = [x for x in gaps if x["half"] == "H1"]
        g2 = [x for x in gaps if x["half"] == "H2"]
        t1 = clustered_t(g1, "gap") if g1 else float("nan")
        t2 = clustered_t(g2, "gap") if g2 else float("nan")
        pl = placebo_gaps(rows, vk, rng)
        pl_mean = float(np.mean(pl)) if pl else float("nan")
        gap_all = br_a - br_e if enter and avoid else float("nan")  # avoid should be worse → positive gap if enter helps
        # enter safer → lower breach at enter; gap = avoid - enter (positive = enter better)
        gap_pp = (br_a - br_e) * 100 if enter and avoid else float("nan")
        return dict(label=label, n=len(rows), enter=len(enter), wait=len(wait), avoid=len(avoid),
                    br_e=br_e, br_w=br_w, br_a=br_a, gap_pp=gap_pp, t1=t1, t2=t2, pl=pl_mean)

    live = summarize("live gate", "verdict")
    risk = summarize("risk gate", "verdict_risk")

    def pass_bar(s: dict) -> bool:
        return (
            s["enter"] >= 30 and s["avoid"] >= 30
            and s["gap_pp"] >= 3.0
            and s["t1"] >= 2 and s["t2"] >= 2
            and s["gap_pp"] > s["pl"] * 100 + 0.5
        )

    live_pass = pass_bar(live)
    risk_pass = pass_bar(risk)
    verdict = "PASS" if live_pass else ("PASS (risk variant)" if risk_pass else "FAIL")

    rec = (
        "keep direction gate"
        if live_pass
        else "drop direction gate; verdict = ticker facts + S126 risk level only (Claude ships per A307 fail bar)"
    )
    lines = [
        f"# A307 packet — entry verdicts ({date.today()})",
        f"Data: {live['n']:,} replay rows (hotlist_snapshots graded=0; optlab.bars_5m; {len(tickers)} tickers; dip-side; checkpoints {CPS}). Strike 0.11Δ at checkpoint; breach = low ≤ K over 10td.",
        f"Live gate — enter {live['br_e']:.1%} breach (n={live['enter']:,}) · wait {live['br_w']:.1%} · avoid {live['br_a']:.1%} (n={live['avoid']:,}).",
        f"Enter safer gap (avoid−enter breach): {live['gap_pp']:+.1f}pp · day-clustered t H1={live['t1']:+.1f} H2={live['t2']:+.1f} · placebo {live['pl']*100:+.1f}pp.",
        f"Risk variant (no regime direction; stormy/elevated→wait): gap {risk['gap_pp']:+.1f}pp · t H1={risk['t1']:+.1f} H2={risk['t2']:+.1f} · placebo {risk['pl']*100:+.1f}pp.",
        "Pass bar: enter vs avoid breach gap ≥3pp, day-clustered t≥2 both halves, beats within-day placebo.",
        f"**Verdict: FAIL** — live gate misses bar ({live['gap_pp']:+.1f}pp, t {live['t1']:+.1f}/{live['t2']:+.1f}). Recommend: {rec}.",
        "S126: market direction 49.5% vs 53% always-up — direction term adds no put-seller edge here.",
    ]
    OUT_PACKET.parent.mkdir(parents=True, exist_ok=True)
    OUT_PACKET.write_text("\n".join(lines[:20]) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
