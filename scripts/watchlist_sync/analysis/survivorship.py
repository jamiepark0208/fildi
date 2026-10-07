"""Survivorship bias in the put backtests: how much does using only names alive today flatter the results?

Our backtests (backtest_puts.py, proto.py) trade today's ~259 tickers back to 2020, so names that went bankrupt,
got delisted or were acquired never appear. This study measures that gap on CRSP, which keeps dead names and
their delisting returns:

  universe each month (point in time): US common stock (shrcd 10/11, NYSE/AMEX/Nasdaq), price >= $3, cap >= $300M,
  >= 10 of the last 12 monthly returns.
  trade: sell a 0.20-delta 1-month put at month end, Black-Scholes at sigma = trailing 12m vol x 1.15 (IV/RV proxy,
  same for every name so it cancels in the comparison), fill x 0.85, settle on next month's return incl. delisting
  return (performance delisting with missing dlret = -30%, Shumway 1997).
  survivors = still listed at the last CRSP month (what our ticker list looks like); all = everyone eligible then.

  bias = survivors-only result minus all-names result, overall and by volatility tercile (speculative names are top).

Run with the WRDS venv (needs Duo once for the pull; cached after):
  research/wrds/.venv/bin/python scripts/watchlist_sync/analysis/survivorship.py pull
  research/wrds/.venv/bin/python scripts/watchlist_sync/analysis/survivorship.py report
"""
from __future__ import annotations

import csv
import gzip
import math
import sys
from collections import defaultdict
from pathlib import Path
from statistics import NormalDist, mean

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parents[1] / "out" / "survivorship"
MSF = OUT / "crsp_msf.csv.gz"
DEL = OUT / "crsp_delist.csv.gz"
START, END = "2018-01-01", "2024-12-31"
ENTRY_FROM = "2020-02-01"  # first entry month-end 2020-02 → matches the 2020-03 → backtests

DELTA, T, FILL, IVRV, PERF_DLRET = 0.20, 1 / 12, 0.85, 1.15, -0.30
MIN_PRICE, MIN_CAP = 3.0, 300e6


def pull() -> None:
    sys.path.insert(0, str(ROOT / "research" / "wrds"))
    from _auth import connect

    OUT.mkdir(parents=True, exist_ok=True)
    db = connect()
    try:
        msf = db.raw_sql(f"""
            SELECT a.permno, a.date, a.prc, a.ret, a.shrout, b.ticker
            FROM crsp.msf a JOIN crsp.msenames b
              ON a.permno = b.permno AND a.date BETWEEN b.namedt AND b.nameendt
            WHERE a.date BETWEEN '{START}' AND '{END}' AND b.shrcd IN (10, 11) AND b.exchcd IN (1, 2, 3)""")
        dl = db.raw_sql(f"""
            SELECT permno, dlstdt, dlret, dlstcd FROM crsp.msedelist
            WHERE dlstdt BETWEEN '{START}' AND '{END}' AND dlstcd > 100""")
    finally:
        db.close()
    _write(MSF, msf, ["permno", "date", "prc", "ret", "shrout", "ticker"])
    _write(DEL, dl, ["permno", "dlstdt", "dlret", "dlstcd"])
    print(f"msf {len(msf):,} rows · delistings {len(dl):,} → {OUT}")


def _write(path: Path, df, cols: list[str]) -> None:
    # Plain csv: pandas datetime ops segfault on Python 3.14 in the WRDS venv.
    with gzip.open(path, "wt", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for row in df[cols].itertuples(index=False):
            w.writerow(["" if v is None or (isinstance(v, float) and math.isnan(v)) else str(v)[:10] if c in ("date", "dlstdt") else v
                        for c, v in zip(cols, row)])


def _read(path: Path) -> list[dict]:
    with gzip.open(path, "rt", newline="") as fh:
        return list(csv.DictReader(fh))


def _num(v: str) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) else x


def _next_ym(ym: str) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    return f"{y + (m == 12)}-{1 if m == 12 else m + 1:02d}"


def bs_put(s: float, k: float, sig: float, t: float) -> float:
    n = NormalDist()
    d1 = (math.log(s / k) + 0.5 * sig * sig * t) / (sig * math.sqrt(t))
    return k * n.cdf(-(d1 - sig * math.sqrt(t))) - s * n.cdf(-d1)


def trades():
    by_p: dict[str, dict[str, dict]] = defaultdict(dict)
    for r in _read(MSF):
        by_p[r["permno"]][r["date"][:7]] = r  # last row per month wins (rows are month-end)
    last_ym = max(ym for g in by_p.values() for ym in g)
    alive = {p for p, g in by_p.items() if last_ym in g}
    dlmap, first_dl = {}, {}
    for d in sorted(_read(DEL), key=lambda d: d["dlstdt"]):
        dlmap[(d["permno"], d["dlstdt"][:7])] = d
        first_dl.setdefault(d["permno"], int(float(d["dlstcd"])))
    z = NormalDist().inv_cdf(1 - DELTA)  # put delta -0.20 → N(d1) = 0.80

    for permno, g in by_p.items():
        yms = sorted(g)
        rets = [_num(g[y]["ret"]) for y in yms]
        survivor = permno in alive
        reason = "alive" if survivor else {2: "merger", 5: "performance"}.get(first_dl.get(permno, 0) // 100, "other")
        for i in range(12, len(yms)):
            ym = yms[i]
            if ym < ENTRY_FROM[:7] or ym >= last_ym:
                continue
            s, shr = abs(_num(g[ym]["prc"]) or 0), _num(g[ym]["shrout"]) or 0
            if not (s >= MIN_PRICE and s * shr * 1000 >= MIN_CAP):
                continue
            hist = [r for r in rets[i - 11:i + 1] if r is not None]
            if len(hist) < 10:
                continue
            mu = mean(hist)
            vol = math.sqrt(sum((r - mu) ** 2 for r in hist) / (len(hist) - 1) * 12)
            sig = max(vol * IVRV, 0.10)
            k = s * math.exp(-(z * sig * math.sqrt(T) - 0.5 * sig * sig * T))
            nxt = _next_ym(ym)
            r = _num(g[nxt]["ret"]) if nxt in g else None
            d = dlmap.get((permno, nxt))
            if d is not None:
                dret = _num(d["dlret"])
                if dret is None:
                    dret = PERF_DLRET if 500 <= int(float(d["dlstcd"])) < 600 else 0.0
                r = (1 + (r or 0.0)) * (1 + dret) - 1
            if r is None:
                continue  # left the sample without a recorded return (exchange move etc.)
            st = s * (1 + r)
            prem = bs_put(s, k, sig, T) * FILL
            yield {"ym": ym, "vol": vol, "survivor": survivor, "reason": reason,
                   "pnl": (prem - max(k - st, 0.0)) / k}


def summarize(ts: list[dict]) -> dict:
    by_m = defaultdict(list)
    for t in ts:
        by_m[t["ym"]].append(t["pnl"])
    monthly = [mean(v) for v in by_m.values()]
    return {"trades": len(ts), "monthly_mean": mean(monthly) if monthly else float("nan"),
            "loss_rate": sum(t["pnl"] < 0 for t in ts) / max(1, len(ts)),
            "tail_rate": sum(t["pnl"] < -0.05 for t in ts) / max(1, len(ts)),
            "worst_month": min(monthly) if monthly else float("nan")}


def report() -> None:
    ts = list(trades())
    by_m = defaultdict(list)
    for t in ts:
        by_m[t["ym"]].append(t)
    for m, xs in by_m.items():  # volatility tercile within each month
        vs = sorted(x["vol"] for x in xs)
        lo, hi = vs[len(vs) // 3], vs[2 * len(vs) // 3]
        for x in xs:
            x["tercile"] = "low" if x["vol"] < lo else "high" if x["vol"] >= hi else "mid"

    lines = ["# Survivorship bias in the put backtests (CRSP, delisting-aware)", "",
             f"0.20Δ 1-month puts, month-end entries {ENTRY_FROM[:7]} → 2024-11, BS at trailing vol × {IVRV}, fill × {FILL}. "
             f"Universe: US common, price ≥ ${MIN_PRICE:.0f}, cap ≥ ${MIN_CAP / 1e6:.0f}M. Return = P&L ÷ collateral per trade.",
             "Survivors = still listed at the last CRSP month (like our ticker list). Bias = survivors − all.", "",
             "| slice | group | trades | mean monthly | loss rate | tail (< −5%) | worst month |",
             "|---|---|---|---|---|---|---|"]
    out = {}
    for sl in ("all", "low", "mid", "high"):
        sub = [t for t in ts if sl == "all" or t["tercile"] == sl]
        for grp, xs in (("all names", sub), ("survivors", [t for t in sub if t["survivor"]])):
            s = summarize(xs)
            out[(sl, grp)] = s
            lines.append(f"| {sl} vol | {grp} | {s['trades']:,} | {s['monthly_mean']:+.2%} | {s['loss_rate']:.1%} | "
                         f"{s['tail_rate']:.1%} | {s['worst_month']:+.2%} |")
    lines += ["", "| slice | bias in mean monthly (survivors − all) | bias in tail rate |", "|---|---|---|"]
    for sl in ("all", "low", "mid", "high"):
        a, s = out[(sl, "all names")], out[(sl, "survivors")]
        lines.append(f"| {sl} vol | {s['monthly_mean'] - a['monthly_mean']:+.2%} pts | {s['tail_rate'] - a['tail_rate']:+.1%} pts |")
    dead = [t for t in ts if not t["survivor"]]
    lines += ["", "Trades in names that later left the sample, by reason: " + ", ".join(
        f"{r} {sum(t['reason'] == r for t in dead):,} (mean {mean([t['pnl'] for t in dead if t['reason'] == r] or [0]):+.2%})"
        for r in ("performance", "merger", "other")),
        "", "Read: subtract the matching bias from backtest_puts / gate-1 monthly returns (our list skews to the high-vol tercile)."]
    text = "\n".join(lines) + "\n"
    (OUT / "report.md").write_text(text)
    print(text)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"
    if cmd == "pull":
        pull()
    elif not MSF.exists():
        raise SystemExit(f"no cache at {MSF}; run `pull` first (WRDS, Duo)")
    else:
        report()
