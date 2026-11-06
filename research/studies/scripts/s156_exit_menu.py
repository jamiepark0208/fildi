#!/usr/bin/env python3
"""S156 / A353 — exit menu on S153-filtered UT/ST/MSO entries, plus the mirror side of S155 and S152.

Question: signals catch swing starts (S153) but round trips lost on the next flip. Does another
exit, or the other side of the option structures, make money net of cost vs a same-exit random?

Stock: Yahoo 5m via the same fetchIntradayHistory S153 uses (61 indicator_events names, ~60d).
  Entries UT/ST/MSO 5m. Filters: unfiltered, first hour ET, 5m+15m agree, SPY+QQQ agree.
  Agree is causal (other signal timestamp <= entry). S153's ± window looks ahead and is not tradable.
  Exits: next flip, ATR target/stop 1/1 2/1 3/1.5, trail 1.5 ATR, 30m/60m/close, chandelier 3 ATR.
  Cost 2 bp/side. Comparator: vol-matched random bar, same ticker-day, same trade direction.
  Side `with` follows the signal. Side `fade` runs the same exit rule in the other direction
  (brackets are re-simulated; flip shares the signal's exit bar).

S155 mirror: short ATM straddle and short the against-signal option, Polygon minute prints already
  cached under research/cache/polygon_options/s155 (no new vendor calls). Holds 30m/60m/close.
  Comparator: same contracts entered 5–30 min after the signal (S155 card, not the pre-signal bug).
  Cost: half the minute's high−low per side (print-range stand-in; cache has no NBBO). When a
  minute has no range, use the median (h−l)/px of minutes that do. Also store the gross lift as
  the break-even spread.

S152 mirror: credit_vertical in option_pricing.py, same strikes as debit_vertical, RH fills
  (buy mid+0.54*spr / sell mid−0.54*spr). optlab.bars_5m + option_chain_history, S152 window.

Pass: lift vs random > 0, Holm p < 0.05 across cells, both date halves > 0, ≥ 30 ticker-days,
  still lift>0 and both halves > 0 after dropping the ticker with the largest lift sum.
  Holm family = stock menu (4×9×2) + S155 per indicator (6×2×3) + credit per indicator×tf×horizon.
  If a cell has < 30 ticker-days, report MDE = 2.8 * sd / sqrt(n).

Run:
  scripts/watchlist_sync/.venv/bin/python research/studies/scripts/s156_exit_menu.py [--smoke]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import mean
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts" / "watchlist_sync"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_plan import connect  # noqa: E402

NY = ZoneInfo("America/New_York")
OUT = ROOT / "research" / "studies" / "out" / "S156"
CACHE155 = ROOT / "research" / "cache" / "polygon_options" / "s155"
COST_STOCK = 0.04  # 2 bp each side, in percentage points
PRE_TOL = 0.25
PRE_BARS = 3
N_RAND = 5
INDS_STOCK = ("ut", "st", "mso")
INDS_OPT = ("ut", "st", "ichimoku", "lsh", "squeeze", "mso")
EXITS = ("flip", "atr_1_1", "atr_2_1", "atr_3_1_5", "trail_1_5", "t_30", "t_60", "t_close", "chand_3")
FILTERS = ("unfiltered", "open", "tf15", "mkt")
ATR_SPEC = {"atr_1_1": (1.0, 1.0), "atr_2_1": (2.0, 1.0), "atr_3_1_5": (3.0, 1.5)}
HOLDS = (("30m", 30), ("60m", 60), ("close", None))

NODE_FETCH = r"""
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
const [modPath, outPath, tickersPath] = process.argv.slice(2);
const tickers = readFileSync(tickersPath, "utf8").trim().split("\n").filter(Boolean);
const m = await import(pathToFileURL(modPath).href);
const out = {};
let done = 0;
async function one(tk) {
  const sessions = await m.fetchIntradayHistory(tk, 60);
  const bars = [];
  for (const arr of sessions.values()) {
    for (const b of arr) bars.push([Math.floor(b.time / 1000), b.open, b.high, b.low, b.close]);
  }
  bars.sort((a, b) => a[0] - b[0]);
  out[tk] = bars;
  done++;
  if (done % 10 === 0) console.error(`yahoo ${done}/${tickers.length}`);
}
const queue = tickers.slice();
async function worker() {
  while (queue.length) {
    const tk = queue.shift();
    if (!tk) break;
    try { await one(tk); } catch (e) { console.error("fail", tk, e?.message || e); }
  }
}
await Promise.all([worker(), worker(), worker()]);
writeFileSync(outPath, JSON.stringify(out));
console.error("yahoo done", Object.keys(out).length);
"""


def load_env() -> None:
    if os.environ.get("DATABASE_URL"):
        return
    p = ROOT / ".env.local"
    for line in p.read_text().splitlines():
        if line.startswith("DATABASE_URL="):
            os.environ["DATABASE_URL"] = line.split("=", 1)[1].strip().strip('"').strip("'")
            return
    raise SystemExit("DATABASE_URL missing")


def et_parts(sec: int) -> tuple[str, int]:
    dt = datetime.fromtimestamp(sec, NY)
    return dt.strftime("%Y-%m-%d"), dt.hour * 60 + dt.minute


def wilder_atr(bars: list[dict], n: int = 14) -> list[float]:
    out = [float("nan")] * len(bars)
    prev = 0.0
    acc = 0.0
    for i, b in enumerate(bars):
        pc = bars[i - 1]["c"] if i else b["c"]
        tr = max(b["h"] - b["l"], abs(b["h"] - pc), abs(b["l"] - pc))
        if i < n:
            acc += tr
            if i == n - 1:
                prev = out[i] = acc / n
        else:
            prev = out[i] = (prev * (n - 1) + tr) / n
    return out


def pnl_at(entry: float, exit_px: float, direction: int) -> float:
    return direction * (exit_px / entry - 1.0) * 100.0 - COST_STOCK


def simulate(bars: list[dict], i: int, end: int, direction: int, atr_i: float, kind: str, flip_j: int | None) -> float | None:
    if i >= end:
        return None
    entry = bars[i]["c"]
    if entry <= 0 or not math.isfinite(atr_i) or atr_i <= 0:
        return None
    if kind == "flip":
        j = flip_j if flip_j is not None else end
        if j <= i:
            j = end
        return pnl_at(entry, bars[j]["c"], direction)
    if kind == "t_30":
        return pnl_at(entry, bars[min(i + 6, end)]["c"], direction)
    if kind == "t_60":
        return pnl_at(entry, bars[min(i + 12, end)]["c"], direction)
    if kind == "t_close":
        return pnl_at(entry, bars[end]["c"], direction)
    if kind in ATR_SPEC:
        tgt_k, stp_k = ATR_SPEC[kind]
        target = entry + direction * tgt_k * atr_i
        stop = entry - direction * stp_k * atr_i
        for j in range(i + 1, end + 1):
            b = bars[j]
            if direction > 0:
                if b["o"] <= stop:
                    return pnl_at(entry, b["o"], direction)
                if b["l"] <= stop:
                    return pnl_at(entry, stop, direction)
                if b["o"] >= target:
                    return pnl_at(entry, b["o"], direction)
                if b["h"] >= target:
                    return pnl_at(entry, target, direction)
            else:
                if b["o"] >= stop:
                    return pnl_at(entry, b["o"], direction)
                if b["h"] >= stop:
                    return pnl_at(entry, stop, direction)
                if b["o"] <= target:
                    return pnl_at(entry, b["o"], direction)
                if b["l"] <= target:
                    return pnl_at(entry, target, direction)
        return pnl_at(entry, bars[end]["c"], direction)
    if kind in ("trail_1_5", "chand_3"):
        k = 1.5 if kind == "trail_1_5" else 3.0
        extreme = entry
        for j in range(i + 1, end + 1):
            b = bars[j]
            atr_j = bars[j - 1]["atr"]
            if not math.isfinite(atr_j) or atr_j <= 0:
                atr_j = atr_i
            stop = extreme - direction * k * atr_j
            if direction > 0:
                if b["o"] <= stop:
                    return pnl_at(entry, b["o"], direction)
                if b["l"] <= stop:
                    return pnl_at(entry, stop, direction)
                extreme = max(extreme, b["h"])
            else:
                if b["o"] >= stop:
                    return pnl_at(entry, b["o"], direction)
                if b["h"] >= stop:
                    return pnl_at(entry, stop, direction)
                extreme = min(extreme, b["l"])
        return pnl_at(entry, bars[end]["c"], direction)
    raise ValueError(kind)


def self_check() -> None:
    bars = []
    for i in range(30):
        px = 100.0
        if i == 21:
            o, h, l, c = 100.0, 110.0, 90.0, 100.0
        else:
            o, h, l, c = px, px + 0.1, px - 0.1, px
        bars.append({"o": o, "h": h, "l": l, "c": c, "atr": 1.0})
    both = simulate(bars, 20, 29, 1, 1.0, "atr_1_1", None)
    assert both is not None and abs(both - (-1.04)) < 1e-6, both
    bars[21] = {"o": 100.0, "h": 110.0, "l": 100.0, "c": 110.0, "atr": 1.0}
    hit = simulate(bars, 20, 29, 1, 1.0, "atr_2_1", None)
    assert hit is not None and abs(hit - 1.96) < 1e-6, hit
    fade = simulate(bars, 20, 29, -1, 1.0, "atr_2_1", None)
    # short target = 98; bar 21 low is 100 so no target; later bars stay ~100
    assert fade is not None and fade < 0, fade
    print("self-check ok", flush=True)


class Acc:
    def __init__(self) -> None:
        self.n = 0
        self.sum = 0.0
        self.wins = 0
        self.days: dict[tuple[str, str], list[float]] = {}

    def add(self, tk: str, day: str, net: float, lift: float) -> None:
        self.n += 1
        self.sum += net
        if net > 0:
            self.wins += 1
        rec = self.days.get((tk, day))
        if rec is None:
            self.days[(tk, day)] = [net, 1.0, lift]
        else:
            rec[0] += net
            rec[1] += 1.0
            rec[2] += lift


def tstat(xs: list[float]) -> tuple[float, float]:
    n = len(xs)
    if n < 3:
        return float("nan"), float("nan")
    m = sum(xs) / n
    var = sum((x - m) ** 2 for x in xs) / (n - 1)
    if var <= 0:
        return float("nan"), float("nan")
    t = m / math.sqrt(var / n)
    p = math.erfc(abs(t) / math.sqrt(2.0))
    return t, p


def holm(ps: list[float]) -> list[float]:
    order = sorted(range(len(ps)), key=lambda i: ps[i] if math.isfinite(ps[i]) else 9)
    out = [1.0] * len(ps)
    prev = 0.0
    m = len(ps)
    for rank, i in enumerate(order):
        raw = ps[i] if math.isfinite(ps[i]) else 1.0
        prev = max(prev, min(1.0, raw * (m - rank)))
        out[i] = prev
    return out


def halves(keys: list[tuple[str, str]], lifts: dict[tuple[str, str], float]) -> tuple[float, float]:
    keys = sorted(keys, key=lambda k: (k[1], k[0]))
    if len(keys) < 4:
        return float("nan"), float("nan")
    mid = len(keys) // 2
    h1 = [lifts[k] for k in keys[:mid]]
    h2 = [lifts[k] for k in keys[mid:]]
    return mean(h1), mean(h2)


def summarize(acc: Acc, family: str, cell: str) -> dict:
    day_lift = {k: rec[2] / rec[1] for k, rec in acc.days.items()}
    day_net = {k: rec[0] / rec[1] for k, rec in acc.days.items()}
    keys = list(day_lift)
    lifts = [day_lift[k] for k in keys]
    t, p = tstat(lifts)
    h1, h2 = halves(keys, day_lift)
    by_tk: dict[str, float] = defaultdict(float)
    for (tk, _d), lv in day_lift.items():
        by_tk[tk] += lv
    top = max(by_tk, key=by_tk.get) if by_tk else ""
    kept = [k for k in keys if k[0] != top]
    ex_lifts = {k: day_lift[k] for k in kept}
    ex_mean = mean(ex_lifts.values()) if ex_lifts else float("nan")
    ex_h1, ex_h2 = halves(kept, ex_lifts) if kept else (float("nan"), float("nan"))
    by_date: dict[str, list[float]] = defaultdict(list)
    by_date_net: dict[str, list[float]] = defaultdict(list)
    for k, lv in day_lift.items():
        by_date[k[1]].append(lv)
        by_date_net[k[1]].append(day_net[k])
    t_day, p_day = tstat([mean(v) for v in by_date.values()])
    worst = min((mean(v) for v in by_date_net.values()), default=float("nan"))
    worst_td = min(day_net.values(), default=float("nan"))
    sd = math.sqrt(sum((x - mean(lifts)) ** 2 for x in lifts) / (len(lifts) - 1)) if len(lifts) > 2 else float("nan")
    n_days = len(keys)
    mde = 2.8 * sd / math.sqrt(n_days) if n_days >= 3 and math.isfinite(sd) else float("nan")
    return {
        "family": family,
        "cell": cell,
        "n": acc.n,
        "n_days": n_days,
        "avg_net": acc.sum / acc.n if acc.n else float("nan"),
        "win": acc.wins / acc.n if acc.n else float("nan"),
        "worst_day": worst,
        "worst_td": worst_td,
        "lift": mean(lifts) if lifts else float("nan"),
        "t": t,
        "p": p,
        "h1": h1,
        "h2": h2,
        "ex_top": top,
        "ex_lift": ex_mean,
        "ex_h1": ex_h1,
        "ex_h2": ex_h2,
        "t_day": t_day,
        "p_day": p_day,
        "mde": mde,
        "n_cal_days": len(by_date),
    }


def fetch_yahoo(tickers: list[str], dest: Path) -> dict:
    if dest.exists() and dest.stat().st_size > 1000:
        print(f"bars cache {dest.name}", flush=True)
        return json.loads(dest.read_text())
    load_env()
    dest.parent.mkdir(parents=True, exist_ok=True)
    tick_path = dest.with_suffix(".tickers")
    tick_path.write_text("\n".join(tickers))
    mod = ROOT / "artifacts/api-server/src/lib/intraday-history.ts"
    fetch_js = dest.parent / "_yahoo_fetch.mts"
    fetch_js.write_text(NODE_FETCH)
    env = os.environ.copy()
    subprocess.run(
        ["pnpm", "exec", "node", "--import", "tsx", str(fetch_js), str(mod), str(dest), str(tick_path)],
        cwd=str(ROOT / "artifacts" / "api-server"),
        env=env,
        check=True,
    )
    return json.loads(dest.read_text())


def build_stock(conn, smoke: bool) -> list[dict]:
    tickers = [r[0] for r in conn.execute(
        "SELECT DISTINCT ticker FROM indicator_events WHERE indicator_id = ANY(%s) AND tf = '5m' AND side IN ('buy','sell') ORDER BY 1",
        (list(INDS_STOCK),),
    ).fetchall()]
    if smoke:
        tickers = tickers[:5]
    print(f"stock tickers {len(tickers)}", flush=True)
    raw = fetch_yahoo(tickers, OUT / ("bars_smoke.json" if smoke else "bars.json"))
    packs: dict[str, dict] = {}
    for tk, rows in raw.items():
        bars = []
        for t, o, h, l, c in rows:
            day, mod = et_parts(int(t))
            if mod < 9 * 60 + 30 or mod >= 16 * 60:
                continue
            bars.append({"t": int(t), "o": float(o), "h": float(h), "l": float(l), "c": float(c), "day": day, "mod": mod})
        if len(bars) < 200:
            continue
        atrs = wilder_atr(bars)
        for b, a in zip(bars, atrs):
            b["atr"] = a
        pre = [float("nan")] * len(bars)
        for i in range(PRE_BARS, len(bars)):
            a = atrs[i]
            if math.isfinite(a) and a > 0:
                pre[i] = abs(bars[i]["c"] - bars[i - PRE_BARS]["c"]) / a
        end = [0] * len(bars)
        for i in range(len(bars) - 1, -1, -1):
            end[i] = end[i + 1] if i + 1 < len(bars) and bars[i + 1]["day"] == bars[i]["day"] else i
        times = [b["t"] for b in bars]
        day_idx: dict[str, list[int]] = defaultdict(list)
        for i, b in enumerate(bars):
            day_idx[b["day"]].append(i)
        packs[tk] = {"bars": bars, "pre": pre, "end": end, "times": times, "day_idx": day_idx}

    ev_rows = conn.execute(
        """SELECT indicator_id, ticker, EXTRACT(EPOCH FROM time)::bigint, side, tf, COALESCE(kind,'')
           FROM indicator_events
           WHERE indicator_id = ANY(%s) AND tf IN ('5m','15m') AND side IN ('buy','sell')
             AND ticker = ANY(%s)""",
        (list(INDS_STOCK), list(packs)),
    ).fetchall()
    mkt_rows = conn.execute(
        """SELECT ticker, EXTRACT(EPOCH FROM time)::bigint, side
           FROM indicator_events
           WHERE ticker IN ('SPY','QQQ') AND side IN ('buy','sell')
             AND time > now() - interval '70 days'"""
    ).fetchall()
    spy: dict[str, list[int]] = {"buy": [], "sell": []}
    qqq: dict[str, list[int]] = {"buy": [], "sell": []}
    for tk, sec, side in mkt_rows:
        (spy if tk == "SPY" else qqq)[side].append(int(sec))
    for d in (spy, qqq):
        for s in d:
            d[s].sort()

    def near(arr: list[int], sec: int) -> bool:
        """Index signal already printed in the last 10 minutes (not the next 10)."""
        lo, hi, ans = 0, len(arr) - 1, -1
        while lo <= hi:
            mid = (lo + hi) // 2
            if arr[mid] <= sec:
                ans = mid
                lo = mid + 1
            else:
                hi = mid - 1
        return ans >= 0 and sec - arr[ans] <= 600

    def locate(pack, sec: int, day: str) -> int | None:
        times = pack["times"]
        lo, hi = 0, len(times) - 1
        ans = -1
        while lo <= hi:
            mid = (lo + hi) // 2
            if times[mid] <= sec:
                ans = mid
                lo = mid + 1
            else:
                hi = mid - 1
        if ans < 0 or pack["bars"][ans]["day"] != day:
            return None
        return ans

    events5 = []
    tf15: dict[tuple, list[int]] = defaultdict(list)
    flips: dict[tuple, list[tuple[int, str]]] = defaultdict(list)
    for ind, tk, sec, side, tf, kind in ev_rows:
        pack = packs.get(tk)
        if not pack:
            continue
        sec = int(sec)
        day, _mod = et_parts(sec)
        i = locate(pack, sec, day)
        if i is None:
            continue
        if tf == "15m":
            tf15[(tk, ind, kind, side, day)].append((i, sec))
        else:
            events5.append((ind, tk, sec, side, kind, day, i))
            flips[(tk, ind)].append((i, side))
    for k in flips:
        flips[k].sort()
    for k in tf15:
        tf15[k].sort()

    def next_flip(tk: str, ind: str, i: int, side: str, day: str, bars) -> int | None:
        arr = flips.get((tk, ind), [])
        lo, hi = 0, len(arr) - 1
        ans = len(arr)
        while lo <= hi:
            mid = (lo + hi) // 2
            if arr[mid][0] <= i:
                lo = mid + 1
            else:
                hi = mid - 1
                ans = mid
        while ans < len(arr):
            j, s = arr[ans]
            if bars[j]["day"] != day:
                return None
            if s != side:
                return j
            ans += 1
        return None

    def rand_index(pack, day: str, i: int, rng) -> int | None:
        pre = pack["pre"]
        p0 = pre[i]
        pool = [j for j in pack["day_idx"][day] if j != i and math.isfinite(pre[j])]
        if not pool:
            return None
        matched = [j for j in pool if math.isfinite(p0) and abs(pre[j] - p0) <= PRE_TOL]
        use = matched if len(matched) >= 5 else pool
        return use[int(rng() * len(use))]

    def mulberry(a: int):
        def rnd():
            nonlocal a
            a = (a + 0x6D2B79F5) & 0xFFFFFFFF
            t = a
            t = (t ^ (t >> 15)) * (t | 1)
            t &= 0xFFFFFFFF
            t = (t + ((t ^ (t >> 7)) * (t | 61))) & 0xFFFFFFFF
            return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
        return rnd

    accs: dict[tuple, Acc] = defaultdict(Acc)
    acc_first: dict[tuple, Acc] = defaultdict(Acc)
    seen: set[tuple] = set()
    used = 0
    for n_ev, (ind, tk, sec, side, kind, day, i) in enumerate(events5):
        pack = packs[tk]
        bars = pack["bars"]
        if not math.isfinite(bars[i]["atr"]) or bars[i]["atr"] <= 0:
            continue
        if i >= pack["end"][i]:
            continue
        mod = bars[i]["mod"]
        flags = ["unfiltered"]
        if 9 * 60 + 30 <= mod < 10 * 60 + 30:
            flags.append("open")
        # 15m signal must already have fired (timestamp <= entry) and sit on this bar or the prior 3.
        if any(t15 <= sec and 0 <= i - j <= 3 for j, t15 in tf15.get((tk, ind, kind, side, day), ())):
            flags.append("tf15")
        if near(spy[side], sec) and near(qqq[side], sec):
            flags.append("mkt")
        flip_j = next_flip(tk, ind, i, side, day, bars)
        end = pack["end"][i]
        atr_i = bars[i]["atr"]
        first_flags = []
        for f in flags:
            k = (f, tk, day, side)
            if k not in seen:
                seen.add(k)
                first_flags.append(f)
        for kind_x in EXITS:
            for trade_side in ("with", "fade"):
                direction = 1 if (side == "buy") == (trade_side == "with") else -1
                # Flip mirror shares the signal exit bar (PLAYBOOK same-row mirror).
                net = simulate(bars, i, end, direction, atr_i, kind_x, flip_j)
                if net is None:
                    continue
                rng = mulberry(int(hashlib.md5(f"s156|{tk}|{i}|{ind}|{kind_x}|{trade_side}".encode()).hexdigest()[:8], 16))
                rnd_pnls = []
                tries = 0
                while len(rnd_pnls) < N_RAND and tries < 25:
                    tries += 1
                    j = rand_index(pack, day, i, rng)
                    if j is None or j >= pack["end"][j]:
                        continue
                    # Same flip rule as the signal: next opposite print of the signal's side.
                    fj = next_flip(tk, ind, j, side, day, bars)
                    rnet = simulate(bars, j, pack["end"][j], direction, bars[j]["atr"], kind_x, fj)
                    if rnet is not None:
                        rnd_pnls.append(rnet)
                if not rnd_pnls:
                    continue
                lift = net - mean(rnd_pnls)
                for f in flags:
                    accs[(f, kind_x, trade_side, "stock")].add(tk, day, net, lift)
                    if f in first_flags:
                        acc_first[(f, kind_x, trade_side, "stock_first")].add(tk, day, net, lift)
        used += 1
        if used % 5000 == 0:
            print(f"stock events {used}", flush=True)
    print(f"stock events used {used} cells {len(accs)} first {len(acc_first)}", flush=True)
    return [summarize(a, "stock", "|".join(k)) for k, a in accs.items()] + [
        summarize(a, "stock_first", "|".join(k)) for k, a in acc_first.items()
    ]


def first_print(prints: list[tuple[int, float, float, float]], t: int):
    for ts, px, h, l in prints:
        if ts >= t:
            return (px, h, l) if ts - t <= 600 else None
    return None


def half_spread(h: float, l: float, px: float, med_frac: float) -> float:
    if px <= 0:
        return 0.0
    if h > l:
        return 0.5 * (h - l)
    return 0.5 * med_frac * px


def load_prints(contract: str, day: str) -> list[tuple[int, float, float, float]] | None:
    f = CACHE155 / f"min_{contract.replace(':', '_')}_{day}.json"
    if not f.exists():
        return None
    body = json.loads(f.read_text())
    out = []
    for r in body.get("results") or []:
        if not r.get("o"):
            continue
        out.append((int(r["t"] // 1000), float(r["o"]), float(r["h"]), float(r["l"])))
    return out


def pick_cached(tk: str, day: str, spot: float) -> tuple[str, str] | None:
    f = CACHE155 / f"ref_{tk}_{day}.json"
    if not f.exists():
        return None
    rows = json.loads(f.read_text()).get("results") or []
    if not rows:
        return None
    exp = min(r["expiration_date"] for r in rows)
    strikes: dict[float, dict] = {}
    for r in rows:
        if r["expiration_date"] != exp:
            continue
        strikes.setdefault(float(r["strike_price"]), {})[r["contract_type"]] = r["ticker"]
    both = []
    for k, v in strikes.items():
        if "call" in v and "put" in v and load_prints(v["call"], day) and load_prints(v["put"], day):
            both.append(k)
    if not both:
        return None
    k = min(both, key=lambda x: abs(x - spot))
    return strikes[k]["call"], strikes[k]["put"]


def leg_cost(px0, h0, l0, px1, h1, l1, med: float) -> float:
    return half_spread(h0, l0, px0, med) + half_spread(h1, l1, px1, med)


def s155_mirror(conn, packs_spot: dict[str, list[dict]] | None, smoke: bool) -> list[dict]:
    # Median print range from a sample of cached minutes.
    rels = []
    files = list(CACHE155.glob("min_*.json"))
    if smoke:
        files = files[:8]
    for f in files[:: max(1, len(files) // 30)]:
        for r in json.loads(f.read_text()).get("results") or []:
            o = r.get("o") or 0
            if o > 0 and r["h"] > r["l"]:
                rels.append((r["h"] - r["l"]) / o)
    med = sorted(rels)[len(rels) // 2] if rels else 0.02
    print(f"s155 spread proxy median (h-l)/px {med:.4f} from {len(rels)} ranged minutes", flush=True)

    ev = conn.execute(
        """SELECT indicator_id, ticker, time, side FROM indicator_events
           WHERE tf = '5m' AND side IN ('buy','sell') AND indicator_id = ANY(%s)
             AND time >= now() - interval '55 days'""",
        (list(INDS_OPT),),
    ).fetchall()
    by_td: dict[tuple[str, str], list] = defaultdict(list)
    for ind, tk, ts, side in ev:
        lt = ts.astimezone(NY)
        if (lt.hour, lt.minute) < (9, 35) or (lt.hour, lt.minute) > (15, 0):
            continue
        day = lt.date().isoformat()
        if not (CACHE155 / f"ref_{tk}_{day}.json").exists():
            continue
        by_td[(tk, day)].append((ind, int(ts.timestamp()) + 300, side))
    days = sorted(by_td)
    if smoke:
        days = days[:3]
    print(f"s155 cached ticker-days {len(days)}", flush=True)

    def spot_of(tk: str, day: str) -> float | None:
        row = conn.execute(
            "SELECT c FROM optlab.bars_5m WHERE ticker=%s AND ts >= %s AND ts < %s ORDER BY ts LIMIT 1",
            (tk, datetime.fromisoformat(day).replace(tzinfo=NY).replace(hour=9, minute=35),
             datetime.fromisoformat(day).replace(tzinfo=NY).replace(hour=16, minute=0)),
        ).fetchone()
        if row:
            return float(row[0])
        return None

    accs: dict[tuple, Acc] = defaultdict(Acc)
    priced = 0
    for tk, day in days:
        spot = spot_of(tk, day)
        if not spot:
            continue
        pc = pick_cached(tk, day, spot)
        if not pc:
            continue
        call, put = load_prints(pc[0], day), load_prints(pc[1], day)
        if not call or not put or len(call) < 20 or len(put) < 20:
            continue
        priced += 1
        close_t = int(datetime.fromisoformat(day).replace(hour=15, minute=50, tzinfo=NY).timestamp())

        def one(t0: int, t1: int, side: str) -> dict[str, float] | None:
            c0 = first_print(call, t0)
            p0 = first_print(put, t0)
            c1 = first_print(call, t1)
            p1 = first_print(put, t1)
            if not c0 or not p0 or not c1 or not p1 or c0[0] < 0.05 or p0[0] < 0.05:
                return None
            prem = c0[0] + p0[0]
            gross_long = (c1[0] + p1[0] - prem) / prem * 100.0
            cost_str = (leg_cost(*c0, *c1, med) + leg_cost(*p0, *p1, med)) / prem * 100.0
            # against-signal option: buy → the put, sell → the call. Short it.
            if side == "buy":
                g = (p1[0] - p0[0]) / p0[0] * 100.0
                cost = leg_cost(*p0, *p1, med) / p0[0] * 100.0
            else:
                g = (c1[0] - c0[0]) / c0[0] * 100.0
                cost = leg_cost(*c0, *c1, med) / c0[0] * 100.0
            return {"short_straddle": -gross_long - cost_str, "short_against": -g - cost}

        for ind, t0, side in by_td[(tk, day)]:
            for hold, mins in HOLDS:
                t1 = close_t if mins is None else t0 + 60 * mins
                if t1 > close_t:
                    continue
                sig = one(t0, t1, side)
                if not sig:
                    continue
                base_vals: dict[str, list[float]] = defaultdict(list)
                for lag in (5, 10, 15, 20, 25, 30):
                    b0 = t0 + lag * 60
                    b1 = close_t if mins is None else b0 + 60 * mins
                    if b1 > close_t or b0 > int(datetime.fromisoformat(day).replace(hour=15, minute=0, tzinfo=NY).timestamp()):
                        continue
                    b = one(b0, b1, side)
                    if not b:
                        continue
                    for s, v in b.items():
                        base_vals[s].append(v)
                for s, v in sig.items():
                    if not base_vals[s]:
                        continue
                    accs[(ind, s, hold)].add(tk, day, v, v - mean(base_vals[s]))
    print(f"s155 priced {priced}", flush=True)
    return [summarize(a, "s155", "|".join(k)) for k, a in accs.items()]


def s152_credit(conn, smoke: bool) -> list[dict]:
    import s152_indicator_option_structures as s152
    from option_pricing import price_structure

    chains = s152.load_chains(conn)
    cidx = s152.chain_index(chains)
    ev_rows = conn.execute(
        """SELECT e.id, e.indicator_id, e.ticker, e.tf, e.time, e.side, e.price::float
           FROM indicator_events e
           JOIN indicator_grades g ON g.event_id = e.id
           WHERE e.side IN ('buy','sell') AND e.time >= %s AND e.time < %s
             AND e.indicator_id = ANY(%s)
           ORDER BY e.time""",
        (s152.START, s152.END, list(s152.TV_inds)),
    ).fetchall()
    if smoke:
        ev_rows = ev_rows[:200]
    tickers = sorted({r[2] for r in ev_rows})
    bars_by = {}
    for tk in tickers:
        raw = conn.execute(
            "SELECT ts, o, h, l, c FROM optlab.bars_5m WHERE ticker=%s AND ts>=%s AND ts<%s ORDER BY ts",
            (tk, s152.START - timedelta(days=1), s152.END),
        ).fetchall()
        if len(raw) < 200:
            continue
        bars_by[tk] = s152.resample_bars([(r[0], float(r[1]), float(r[2]), float(r[3]), float(r[4])) for r in raw])
    meta_all = s152.build_meta(bars_by)
    events = []
    for eid, ind, tk, tf, ts, side, price in ev_rows:
        m = meta_all.get((tk, tf))
        if not m or price is None:
            continue
        sec = int(ts.timestamp())
        idx = next((i for i, b in enumerate(m.bars) if abs(b["time"] - sec) < 600), None)
        if idx is None:
            continue
        ed = ts.astimezone(NY).date()
        snap = s152.snap_on(cidx, chains, tk, ed)
        if not snap:
            continue
        exp_d = s152.pick_expiry(snap, ed)
        if not exp_d:
            continue
        events.append({"id": eid, "ind": ind, "tk": tk, "tf": tf, "side": side, "price": float(price),
                        "i": idx, "day": m.days[idx], "snap": snap, "exp": exp_d[0], "dte": exp_d[1]})
    print(f"credit events {len(events)}", flush=True)
    accs: dict[tuple, Acc] = defaultdict(Acc)
    draws = 2 if smoke else 8
    for n, ev in enumerate(events):
        m = meta_all[(ev["tk"], ev["tf"])]
        i = ev["i"]
        p0 = m.pre[i]
        for hz in s152.HORIZONS:
            ej = m.exit_i[hz][i]
            if ej is None:
                continue
            hold_min = (m.bars[ej]["end"] - m.bars[i]["end"]) / 60.0
            sig = price_structure("credit_vertical", ev["side"], ev["price"], ev["snap"], ev["exp"], ev["dte"], m.bars[ej]["close"], hold_min)
            if sig is None:
                continue
            pool = [a for a in m.pool if m.days[a] == ev["day"] and a != i and math.isfinite(m.pre[a])]
            matched = [a for a in pool if math.isfinite(p0) and abs(m.pre[a] - p0) <= PRE_TOL]
            use = matched if len(matched) >= 5 else pool
            if not use:
                continue
            rng = s152.mulberry32(s152.hash_str(f"s156|{ev['id']}|{hz}"))
            rnd = []
            tries = 0
            while len(rnd) < draws and tries < draws * 15:
                tries += 1
                a = use[int(rng() * len(use))]
                ej2 = m.exit_i[hz][a]
                if ej2 is None:
                    continue
                ed2 = date.fromisoformat(m.days[a])
                snap2 = s152.snap_on(cidx, chains, ev["tk"], ed2)
                if not snap2:
                    continue
                ex2 = s152.pick_expiry(snap2, ed2)
                if not ex2:
                    continue
                hm2 = (m.bars[ej2]["end"] - m.bars[a]["end"]) / 60.0
                r = price_structure("credit_vertical", ev["side"], m.bars[a]["close"], snap2, ex2[0], ex2[1], m.bars[ej2]["close"], hm2)
                if r is not None:
                    rnd.append(r)
            if not rnd:
                continue
            accs[(ev["ind"], ev["tf"], hz, "credit_vertical")].add(ev["tk"], ev["day"], sig, sig - mean(rnd))
        if n and n % 400 == 0:
            print(f"credit {n}/{len(events)}", flush=True)
    return [summarize(a, "s152", "|".join(k)) for k, a in accs.items()]


def _passes(r: dict, ph: float) -> bool:
    def ok(x) -> bool:
        return isinstance(x, (int, float)) and math.isfinite(x) and x > 0

    return bool(
        r["n_days"] >= 30 and ph < 0.05 and ok(r["lift"]) and ok(r["avg_net"])
        and ok(r["h1"]) and ok(r["h2"]) and ok(r["ex_lift"]) and ok(r["ex_h1"]) and ok(r["ex_h2"])
    )


def finish(rows: list[dict]) -> None:
    primary = [r for r in rows if r["family"] != "stock_first"]
    extra = [r for r in rows if r["family"] == "stock_first"]
    ph = holm([r["p"] for r in primary])
    for r, p_h in zip(primary, ph):
        r["p_holm"] = p_h
        r["pass"] = _passes(r, p_h)
    ph2 = holm([r["p"] for r in extra]) if extra else []
    for r, p_h in zip(extra, ph2):
        r["p_holm"] = p_h
        r["pass"] = _passes(r, p_h)
    rows = primary + extra
    rows.sort(key=lambda r: (-(r["lift"] if math.isfinite(r["lift"]) else -1e9), -(r["t"] if math.isfinite(r["t"]) else -1e9)))
    OUT.mkdir(parents=True, exist_ok=True)
    def clean(o):
        if isinstance(o, float) and not math.isfinite(o):
            return None
        return o
    (OUT / "cells.json").write_text(json.dumps(rows, indent=1, default=clean))
    npass = sum(1 for r in rows if r["pass"])
    print(f"cells {len(rows)} pass {npass}", flush=True)
    for r in rows[:8]:
        print(
            f"{r['cell'][:72]:72s} days {r['n_days']:4d} n {r['n']:5d} net {r['avg_net']:+7.3f} "
            f"win {r['win']*100:4.0f}% worst {r['worst_day']:+6.2f} lift {r['lift']:+6.3f} "
            f"t {r['t']:+5.2f} h {r['h1']:+5.2f}/{r['h2']:+5.2f} holm {r['p_holm']:.3f} "
            f"ex {r['ex_lift']:+5.2f} {'PASS' if r['pass'] else ''}",
            flush=True,
        )
    thin = [r for r in rows if r["n_days"] < 30]
    if thin:
        print(f"thin cells {len(thin)} example MDE {thin[0]['cell']} n_days {thin[0]['n_days']} mde {thin[0]['mde']}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--only", choices=("stock", "s155", "credit", "all"), default="all")
    a = ap.parse_args()
    self_check()
    load_env()
    conn = connect()
    rows: list[dict] = []
    if a.only in ("stock", "all"):
        rows += build_stock(conn, a.smoke)
    if a.only in ("s155", "all"):
        rows += s155_mirror(conn, None, a.smoke)
    if a.only in ("credit", "all"):
        rows += s152_credit(conn, a.smoke)
    if a.only != "all" and (OUT / "cells.json").exists():
        old = json.loads((OUT / "cells.json").read_text())
        keep = {"s155", "s152"} if a.only == "stock" else {"stock", "stock_first"} if a.only == "credit" else {"stock", "stock_first", "s152"}
        if a.only == "s155":
            keep = {"stock", "stock_first", "s152"}
        rows += [r for r in old if r.get("family") in keep]
    finish(rows)


if __name__ == "__main__":
    main()
