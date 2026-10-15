"""PM alerts (Claude, portfolio-manager role, user 2026-10-14) → Live › Portfolio Alerts tab. Script only, no AI.

How it decides (probabilistic core, deterministic thresholds the user owns):
  1. Odds per short put = the market's own: each put's implied vol (Schwab quotes; RH snapshot only if Schwab is down) gives P(ITM at
     expiry). Checked on the trader's 926 puts (S015 trades, 2026-02→10): predicted 18% ITM vs 21% realized, ratio 1.14 with week-cluster
     90% CI 0.73–1.55 → no detectable bias, so no fudge factor.
  2. Puts don't breach independently (S015 Q4: per-expiry ITM share SD 0.236 vs 0.098 if independent). A one-factor model with
     correlation RHO = 0.6 reproduces that SD (simulated 0.231), so every path moves all names with one common shock + own noise.
  3. Monte Carlo (20k paths) to the nearest expiry per account: which puts assign, longs move too (60-day realized vol), then
     margin requirement (pm_book's estimated maintenance ratio) vs equity → P(margin call), P(assignment > cash), assignment cash p90.
  4. Bullets only when a threshold is crossed (THRESH; defaults, user-tunable). Each bullet keeps a stable key; "new" / "worse" /
     "better" is relative to the previous run, so an unchanged risk reads as one quiet line instead of a fresh alarm.
  The crash-week budget (25% red / 20% amber, user 2026-10-14) is a scenario, not a probability: stated as "if", never as odds.

Schedule: LaunchAgent com.fildi.pm-alerts (every 15 min); this script runs every call in market hours (06:30–13:15 PT weekdays) and at
most every 2 h otherwise. Output: table watchlist_sync.pm_alerts (one row per run, payload jsonb) → GET /api/pm/alerts.

    .venv/bin/python pm_alerts.py           # scheduled run (skips when not due)
    .venv/bin/python pm_alerts.py --now     # run now and print the bullets
"""
from __future__ import annotations

import json
import math
import random
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from build_plan import connect, rows

HERE = Path(__file__).resolve().parent
OUT = HERE / "out" / "pm"
PT = ZoneInfo("America/Los_Angeles")
RHO = 0.6          # calibrated to S015 expiry clustering (see docstring)
PATHS = 20_000
THRESH = {          # defaults pending user tuning
    "margin_amber": 0.10, "margin_red": 0.30,   # P(margin call at next expiry)
    "cash_amber": 0.10, "cash_red": 0.30,       # P(assignment cash > cash), cash accounts
    "assign_listed": 0.50,                      # list a put in the expiry bullet when P(assign) ≥ this and ≤ 2 trading days left
}
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.pm_alerts (
  id serial PRIMARY KEY, generated_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL)"""
f = lambda v: f"${v:,.0f}"  # noqa: E731
LEVEL = {"green": 0, "amber": 1, "red": 2}


def market_hours(now: datetime) -> bool:
    return now.weekday() < 5 and (6, 30) <= (now.hour, now.minute) <= (13, 15)


def due(conn, now: datetime) -> bool:
    if market_hours(now):
        return True
    last = conn.execute("SELECT max(generated_at) FROM watchlist_sync.pm_alerts").fetchone()[0]
    return last is None or (now - last).total_seconds() >= 2 * 3600


def realized_vol(conn, tickers: list[str]) -> dict[str, float]:
    out = {}
    for t in tickers:
        px = [r["c"] for r in rows(conn, "SELECT close::float8 AS c FROM prices_historical WHERE ticker = %s ORDER BY date DESC LIMIT 61", (t,))]
        rets = [math.log(a / b) for a, b in zip(px, px[1:]) if a and b]
        out[t] = (sum(r * r for r in rets) / len(rets)) ** 0.5 * math.sqrt(252) if len(rets) > 20 else 0.6
    return out


def simulate(book: dict, acct: str, longs: list[dict], vols: dict[str, float], rng: random.Random) -> dict | None:
    b = book["accounts"][acct]
    puts = [p for p in book["positions"] if p["account"] == acct and p["iv"]]
    if not puts:
        return None
    near = min(p["expiry"] for p in puts)
    days = min(p["days_left"] for p in puts if p["expiry"] == near)
    t = max(days, 0.5) / 252
    names = sorted({p["ticker"] for p in puts} | {x["t"] for x in longs})
    ratio, margin = b.get("maint_ratio_est"), "maint_ratio_est" in b
    expiring = [p for p in puts if p["expiry"] == near]
    draws = []  # common random numbers: reuse the same paths when testing "what if I close X"
    for _ in range(PATHS):
        m = rng.gauss(0, 1)
        z = {n: math.sqrt(RHO) * m + math.sqrt(1 - RHO) * rng.gauss(0, 1) for n in names}
        draws.append(z)

    def run(closed: frozenset[int]) -> dict:
        calls = short = 0
        assign_cash = []
        n_assigned = [0] * len(expiring)
        for z in draws:
            eq, req_long, cash_need = b["equity"], 0.0, 0.0
            for x in longs:
                s = vols.get(x["t"], 0.6)
                r = math.exp(-0.5 * s * s * t + s * math.sqrt(t) * z[x["t"]])
                eq += (x["mv"] or 0) * (r - 1)
                req_long += (x["mv"] or 0) * r
            for i, p in enumerate(expiring):
                if i in closed:
                    continue
                s = p["iv"]
                st = p["spot"] * math.exp(-0.5 * s * s * t + s * math.sqrt(t) * z[p["ticker"]])
                mark = p["close_cost"] / (100 * p["qty"]) if p["qty"] else 0
                eq += (mark - max(p["strike"] - st, 0)) * 100 * p["qty"]
                if st < p["strike"]:
                    n_assigned[i] += 1
                    cash_need += p["assign_cash"]
                    req_long += st * 100 * p["qty"]
            assign_cash.append(cash_need)
            if margin and eq < ratio * req_long:
                calls += 1
            if not margin and cash_need > max(b["cash"], 0) + 1:
                short += 1
        assign_cash.sort()
        return {"p_call": calls / PATHS if margin else None, "p_short": short / PATHS if not margin else None,
                "assign_p90": assign_cash[int(0.9 * PATHS)], "p_assign": [n / PATHS for n in n_assigned]}

    base = run(frozenset())
    key = "p_call" if margin else "p_short"
    amber = THRESH["margin_amber"] if margin else THRESH["cash_amber"]
    # cheapest closes (per $ of close cost) that bring the risk under the amber line — information, not advice
    closed, cost, cur = set(), 0.0, base
    while cur[key] is not None and cur[key] >= amber and len(closed) < len(expiring):
        best = None
        for i, p in enumerate(expiring):
            if i in closed:
                continue
            r = run(frozenset(closed | {i}))
            gain = (cur[key] - r[key]) / max(p["close_cost"], 1)
            if best is None or gain > best[0]:
                best = (gain, i, r)
        closed.add(best[1]); cost += expiring[best[1]]["close_cost"]; cur = best[2]
    return {"expiry": near, "days_left": days, "margin": margin, "risk": base[key], "assign_p90": base["assign_p90"],
            "puts": [{**p, "p_assign": pa} for p, pa in zip(expiring, base["p_assign"])],
            "fix": {"close": [f"{expiring[i]['ticker']} {expiring[i]['strike']:g}P" for i in sorted(closed)], "cost": cost,
                    "risk_after": cur[key]} if closed else None}


def bullets(book: dict, sims: dict) -> list[dict]:
    out = []
    for acct, b in book["accounts"].items():
        s = sims.get(acct)
        if s:
            r, kind = s["risk"], "margin call" if s["margin"] else "assignment > cash"
            lo, hi = (THRESH["margin_amber"], THRESH["margin_red"]) if s["margin"] else (THRESH["cash_amber"], THRESH["cash_red"])
            if r >= lo:
                txt = f"{acct}: {r:.0%} chance of a {kind} at {s['expiry'][5:]} expiry (bad-case assignment {f(s['assign_p90'])})."
                if s["fix"]:
                    txt += f" Closing {', '.join(s['fix']['close'])} ({f(s['fix']['cost'])}) → {s['fix']['risk_after']:.0%}."
                out.append({"key": f"{acct}:{'margin' if s['margin'] else 'cash'}", "level": "red" if r >= hi else "amber", "text": txt, "value": r})
            likely = [p for p in s["puts"] if p["p_assign"] >= THRESH["assign_listed"]]
            if likely and s["days_left"] <= 2:
                top = sorted(likely, key=lambda p: -p["p_assign"])
                names = ", ".join(f"{p['ticker']} {p['strike']:g}P {p['p_assign']:.0%}" for p in top[:5]) + (f" +{len(top) - 5} more" if len(top) > 5 else "")
                out.append({"key": f"{acct}:expiry", "level": "amber", "value": len(likely),
                            "text": f"{acct}: likely assigned {s['expiry'][5:]}: {names}; cash needed if all {f(sum(p['assign_cash'] for p in likely))}."})
        drop, rules = b.get("crash_drop_pct") or 0, book["rules"]
        if drop > rules["crash_warn"]:
            out.append({"key": f"{acct}:crash", "level": "red" if drop > rules["crash_budget"] else "amber", "value": drop,
                        "text": f"{acct}: if every name fell 30% in a week, equity −{drop:.0%} (budget {rules['crash_budget']:.0%}). "
                                f"New puts here add to it."})
    return sorted(out, key=lambda x: (-LEVEL[x["level"]], x["key"]))


def main() -> None:
    now = datetime.now(PT)
    conn = connect()
    conn.execute(DDL)
    conn.commit()
    if "--now" not in sys.argv and not due(conn, now):
        return
    # always try Schwab (after hours = closing quotes; RH snapshot IVs disagree with Schwab's, e.g. USAR 1.79 vs 1.01); pm_book falls back
    subprocess.run([sys.executable, str(HERE / "pm_book.py"), "--live"], cwd=HERE, check=True, capture_output=True)
    book = json.loads((OUT / "book-latest.json").read_text())
    acct_ids = {"IRA": "772445425", "FILDI": "5QU47796"}
    snap = book["snapshot_id"]
    allongs = rows(conn, """SELECT account, UPPER(symbol) AS t, SUM(market_value)::float8 AS mv FROM portfolio_positions
                            WHERE snapshot_id = %s GROUP BY 1, 2""", (snap,))
    vols = realized_vol(conn, sorted({x["t"] for x in allongs}))
    rng = random.Random(snap)
    sims = {a: simulate(book, a, [x for x in allongs if x["account"] == acct_ids.get(a)], vols, rng) for a in book["accounts"]}
    prev = conn.execute("SELECT payload FROM watchlist_sync.pm_alerts ORDER BY id DESC LIMIT 1").fetchone()
    prev = {x["key"]: x for x in (prev[0]["bullets"] if prev else [])}
    bl = bullets(book, sims)
    for x in bl:
        p = prev.get(x["key"])
        x["change"] = "new" if not p else "worse" if (LEVEL[x["level"]], x["value"]) > (LEVEL[p["level"]], p["value"] * 1.1) else \
                      "better" if (LEVEL[x["level"]], x["value"]) < (LEVEL[p["level"]], p["value"] * 0.9) else None
    payload = {"generated": now.isoformat(timespec="seconds"), "priced_at": book.get("live_priced_at") or book["snapshot_at"],
               "prices": "live Schwab" if book.get("live_priced_at") else "Robinhood snapshot", "snapshot_at": book["snapshot_at"],
               "bullets": bl, "cleared": [k for k in prev if k not in {x["key"] for x in bl}],
               "model": {"rho": RHO, "paths": PATHS, "thresholds": THRESH, "rules": book["rules"]},
               "accounts": {a: {"status": b["status"], **({"risk": sims[a]["risk"], "expiry": sims[a]["expiry"]} if sims.get(a) else {})}
                            for a, b in book["accounts"].items()}}
    conn.execute("INSERT INTO watchlist_sync.pm_alerts (payload) VALUES (%s)", (json.dumps(payload, default=str),))
    conn.commit()
    if "--now" in sys.argv:
        for x in bl:
            print(f"[{x['level']}{' · ' + x['change'] if x['change'] else ''}] {x['text']}")


if __name__ == "__main__":
    main()
