"""Step 2 due diligence: where should STREET (analyst revisions / EPS drift / predicted surprise) live?

Read-only analysis. Recomputes fit verdicts for the same point-in-time inputs (latest fit_score_history run) under:
  S0  baseline fit-1.3: STREET is a gate pillar (green needs STREET ≥ 55; red if OWN and STREET both < 35)
  S1  STREET excluded: no STREET gate, no STREET flags (ARM ≤ 15, predicted miss)
  S2k STREET as reward/penalty on OWN: adjOWN = OWN + k·(STREET − 50)/50 (k = 5, 10, 15); STREET flags stay as penalties
Also: overlap of STREET with the fund score's own street metrics (growth family), and early predictive evidence from
StarMine history (combined alpha, predicted surprise) vs forward 21-trading-day returns.

Usage: ../.venv/bin/python street_scenarios.py   → out/step2/street_scenarios.md (+ .json)
"""
from __future__ import annotations

import json
import math
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402
import fit_model as FM  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "step2"
STREET_FLAG_PREFIXES = ("analysts cutting hard", "StarMine predicts")
KS = (5, 10, 15)


def spearman(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    n = len(pairs)
    if n < 8:
        return None, n

    def rank(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2
            i = j + 1
        return r

    rx, ry = rank([p[0] for p in pairs]), rank([p[1] for p in pairs])
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = math.sqrt(sum((a - mx) ** 2 for a in rx))
    vy = math.sqrt(sum((b - my) ** 2 for b in ry))
    return (cov / (vx * vy) if vx and vy else None), n


def verdict(s: dict, scenario: str, k: float = 0, red_mode: str = "own") -> tuple[str, float | None]:
    """Same color rules as fit_model.score, with STREET handled per scenario. Returns (verdict, effective OWN)."""
    own, street, flags = s["own"], s["street"], list(s["flags"] or [])
    inp = s["inputs"]
    credit = None if inp.get("peer") in FM.LEVERED_FINANCIALS else inp.get("credit")
    if s["role"] == "etf":
        return "purple", own
    if scenario == "S1":
        flags = [f for f in flags if not f.startswith(STREET_FLAG_PREFIXES)]
    eff = own
    if scenario == "S2" and own is not None and street is not None:
        eff = max(0.0, min(100.0, own + k * (street - 50) / 50))
    credit_ok = (credit is None and inp.get("peer") in FM.LEVERED_FINANCIALS) or (credit or 0) >= FM.GREEN_CREDIT
    if scenario == "S0":
        red = len(flags) >= FM.RED_FLAGS or (own is not None and street is not None and own < FM.RED_BOTH and street < FM.RED_BOTH)
        green = own is not None and street is not None and own >= FM.GREEN_OWN and street >= FM.GREEN_STREET and credit_ok
    else:
        # red_mode isolates the red-rule change from STREET's effect:
        #   own   = OWN alone < 35 is red · flags = only 2+ flags are red · both = S0's rule (OWN and STREET < 35) kept
        weak = {"own": eff is not None and eff < FM.RED_BOTH, "flags": False,
                "both": own is not None and street is not None and eff is not None and eff < FM.RED_BOTH and street < FM.RED_BOTH}[red_mode]
        red = len(flags) >= FM.RED_FLAGS or weak
        green = eff is not None and eff >= FM.GREEN_OWN and credit_ok
    if red:
        return "red", eff
    if green:
        return "green", eff
    if s["premium"] is not None and s["premium"] >= FM.YELLOW_PREMIUM and (eff or 0) >= FM.YELLOW_OWN and (s["fit"] or 0) >= FM.YELLOW_FIT and not flags:
        return "yellow", eff
    return "", eff


def put_ok(s: dict, v: str, eff: float | None, scenario: str) -> bool:
    """publish_model_list sell_puts cross-check under the scenario."""
    flags = s["flags"] or []
    if scenario == "S1":
        flags = [f for f in flags if not f.startswith(STREET_FLAG_PREFIXES)]
    return v != "red" and not flags and eff is not None and eff >= FM.YELLOW_OWN


def forward_ic(conn) -> dict:
    """Monthly cross-sectional Spearman IC of StarMine history vs next-21-trading-day return (prices 2025-04 → now)."""
    px = defaultdict(list)
    for r in rows(conn, "SELECT ticker, date, close::float8 c FROM prices_historical WHERE date >= '2025-04-01' ORDER BY ticker, date"):
        px[r["ticker"]].append((r["date"], r["c"]))
    dates_by_t = {t: [d for d, _ in v] for t, v in px.items()}

    def fwd(t, d0, h=21):
        ds = dates_by_t.get(t)
        if not ds:
            return None
        import bisect
        i = bisect.bisect_right(ds, d0)  # first trading day strictly after the observation date (no look-ahead)
        if i + h >= len(ds):
            return None
        return px[t][i + h][1] / px[t][i][1] - 1

    out = {}
    hist = rows(conn, "SELECT metric, ticker, obs_date, value::float8 v FROM lseg_research.starmine_history WHERE obs_date >= '2025-04-01'")
    by = defaultdict(lambda: defaultdict(list))
    for r in hist:
        by[r["metric"]][(r["obs_date"].year, r["obs_date"].month)].append(r)
    for metric, months in by.items():
        ics = []
        for ym, obs in sorted(months.items()):
            last = {}
            for o in obs:  # one observation per ticker per month (latest)
                if o["ticker"] not in last or o["obs_date"] > last[o["ticker"]]["obs_date"]:
                    last[o["ticker"]] = o
            xs, ys = [], []
            for o in last.values():
                f = fwd(o["ticker"], o["obs_date"])
                if f is not None and o["v"] is not None:
                    xs.append(o["v"]), ys.append(f)
            ic, n = spearman(xs, ys)
            if ic is not None:
                ics.append((f"{ym[0]}-{ym[1]:02d}", ic, n))
        if ics:
            m = sum(i for _, i, _ in ics) / len(ics)
            sd = math.sqrt(sum((i - m) ** 2 for _, i, _ in ics) / max(len(ics) - 1, 1))
            out[metric] = {"months": len(ics), "mean_ic": m, "t": m / (sd / math.sqrt(len(ics))) if sd else None,
                           "hit_rate": sum(1 for _, i, _ in ics if i > 0) / len(ics), "avg_n": sum(n for *_, n in ics) / len(ics),
                           "series": ics}
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        run_at = rows(conn, "SELECT MAX(computed_at) t FROM watchlist_sync.fit_score_history")[0]["t"]
        S = rows(conn, "SELECT * FROM watchlist_sync.fit_score_history WHERE computed_at = %s", (run_at,))
        fund = {r["ticker"]: r for r in rows(conn, """SELECT DISTINCT ON (ticker) ticker, fund_total::float8 total, fund_growth::float8 growth,
                 fund_value::float8 value, fund_quality::float8 quality, fund_safety::float8 safety FROM fund_score_snapshots ORDER BY ticker, as_of DESC""")}
        plan_puts = {r["ticker"] for r in rows(conn, """SELECT ticker FROM watchlist_sync.plan_items WHERE plan_id = (SELECT MAX(id) FROM watchlist_sync.plans)
                       AND list_key = 'sell_puts' AND l1_pass""")}
        ic = forward_ic(conn)

    scen = {"S0": {}, "S1": {}, "S1-flagsonly": {}, **{f"S2k{k}": {} for k in KS}, "S2k10-bothrule": {}}
    for s in S:
        scen["S0"][s["ticker"]] = verdict(s, "S0")
        scen["S1"][s["ticker"]] = verdict(s, "S1")
        scen["S1-flagsonly"][s["ticker"]] = verdict(s, "S1", red_mode="flags")
        scen["S2k10-bothrule"][s["ticker"]] = verdict(s, "S2", 10, red_mode="both")
        for k in KS:
            scen[f"S2k{k}"][s["ticker"]] = verdict(s, "S2", k)
    byt = {s["ticker"]: s for s in S}
    mism = [t for t in byt if scen["S0"][t][0] != (byt[t]["verdict"] or "")]
    assert not mism, f"S0 does not reproduce stored fit-1.3 verdicts: {mism[:10]}"
    stocks = [s for s in S if s["role"] != "etf"]

    L = [f"# Step 2: STREET scenario analysis ({date.today()})", "",
         f"Inputs: fit_score_history run {run_at:%Y-%m-%d %H:%M} ({len(S)} names, {len(stocks)} non-ETF), model {FM.MODEL_VERSION}. "
         f"Same point-in-time inputs in every scenario; only STREET's role changes. Baseline code pinned in `out/baselines/step2_20261005/manifest.json`.", ""]

    L += ["## 1. Verdict counts", "", "| scenario | green | yellow | red | none | changed vs S0 |", "|---|---|---|---|---|---|"]
    for name, m in scen.items():
        c = Counter(v for t, (v, _) in m.items() if byt[t]["role"] != "etf")
        ch = sum(1 for t in m if m[t][0] != scen["S0"][t][0])
        L.append(f"| {name} | {c['green']} | {c['yellow']} | {c['red']} | {c['']} | {ch} |")

    for name in ("S1", "S1-flagsonly", "S2k10", "S2k10-bothrule"):
        L += ["", f"### Transitions S0 → {name}", "", "| from → to | n | tickers |", "|---|---|---|"]
        tr = defaultdict(list)
        for t in scen["S0"]:
            a, b = scen["S0"][t][0], scen[name][t][0]
            if a != b:
                tr[(a or "none", b or "none")].append(t)
        for (a, b), ts in sorted(tr.items(), key=lambda x: -len(x[1])):
            L.append(f"| {a} → {b} | {len(ts)} | {' '.join(sorted(ts))} |")

    # Rank stability of the ownability composite
    L += ["", "## 2. Rank stability of the ownership score", "", "| compare | Spearman ρ | n | top-30 overlap |", "|---|---|---|---|"]
    base = {t: byt[t]["own"] for t in byt if byt[t]["role"] != "etf"}
    for k in KS:
        adj = {t: scen[f"S2k{k}"][t][1] for t in base}
        ts = [t for t in base if base[t] is not None and adj[t] is not None]
        rho, n = spearman([base[t] for t in ts], [adj[t] for t in ts])
        top = lambda d: set(sorted(ts, key=lambda t: -d[t])[:30])
        L.append(f"| OWN vs OWN±{k}·STREET | {rho:.3f} | {n} | {len(top(base) & top(adj))}/30 |")

    # Overlap: is STREET already inside the fund score?
    L += ["", "## 3. Double-counting check: STREET vs the fund score (which already has PT upside, EPS surprise, IBES revisions/SUE)", "",
          "| pair | Spearman ρ | n |", "|---|---|---|"]
    pairs = [("STREET", lambda s: s["street"]), ("ARM (revisions)", lambda s: s["inputs"].get("arm")),
             ("pred. surprise", lambda s: s["inputs"].get("ps")), ("EPS drift 30d", lambda s: s["inputs"].get("drift"))]
    for label, fx in pairs:
        for fl in ("growth", "total"):
            xs = [fx(s) for s in stocks]
            ys = [(fund.get(s["ticker"]) or {}).get(fl) for s in stocks]
            rho, n = spearman(xs, ys)
            L.append(f"| {label} vs fund_{fl} | {rho:.3f} | {n} |" if rho is not None else f"| {label} vs fund_{fl} | n/a | {n} |")
    rho, n = spearman([s["street"] for s in stocks], [s["own"] for s in stocks])
    L.append(f"| STREET vs OWN | {rho:.3f} | {n} |")

    # Trade ideas that flip
    L += ["", "## 4. Current put ideas under each scenario (sell-puts cross-check)", "", "| ticker | " + " | ".join(scen) + " |", "|---|" + "---|" * len(scen)]
    for t in sorted(plan_puts):
        if t not in byt:
            continue
        cells = []
        for name, m in scen.items():
            v, eff = m[t]
            ok = put_ok(byt[t], v, eff, "S1" if name.startswith("S1") else name[:2])
            cells.append(f"{'✅' if ok else '✋'} {v or '–'} ({eff:.0f})" if eff is not None else f"✋ {v or '–'}")
        L.append(f"| {t} | " + " | ".join(cells) + " |")

    # Biggest movers under S2k10
    mv = sorted(((scen["S2k10"][t][1] - base[t], t) for t in base if base[t] is not None and scen["S2k10"][t][1] is not None), reverse=True)
    fmt = lambda xs: ", ".join(f"{t} {d:+.1f} (STREET {byt[t]['street']:.0f})" for d, t in xs)
    L += ["", "## 5. Biggest movers with STREET as ±10 reward/penalty", "", f"- Up: {fmt(mv[:8])}", f"- Down: {fmt(mv[-8:][::-1])}"]

    # Predictive evidence
    L += ["", "## 6. Early predictive evidence (StarMine history → next 21 trading days, monthly cross-section)", "",
          "| signal | months | mean IC | t-stat | months IC>0 | avg names |", "|---|---|---|---|---|---|"]
    for metric, r in ic.items():
        L.append(f"| {metric} | {r['months']} | {r['mean_ic']:+.3f} | {r['t']:+.2f} | {r['hit_rate']:.0%} | {r['avg_n']:.0f} |" if r["t"] is not None else f"| {metric} | {r['months']} | {r['mean_ic']:+.3f} | n/a | | |")
    L += ["", "Caveats: ~18 months of prices and ~105 names, so |IC| < ~0.05 is noise. ARM and EPS drift have no history here yet "
          "(only combined alpha + predicted surprise), and there's no fund-score history, so OWN can't be tested the same way. "
          "Step 3 (LSEG history pull, WRDS CRSP/IBES) is what makes this conclusive."]

    (OUT / "street_scenarios.md").write_text("\n".join(L) + "\n")
    json.dump({"run_at": str(run_at), "scenarios": {k: {t: v for t, v in m.items()} for k, m in scen.items()},
               "ic": {k: {kk: vv for kk, vv in v.items()} for k, v in ic.items()}}, open(OUT / "street_scenarios.json", "w"), default=str, indent=1)
    print("\n".join(L))


if __name__ == "__main__":
    main()
