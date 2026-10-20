"""Intraday re-check of the published Model List (user 2026-10-11): re-verify + re-publish when the market or a stock moves.

Called by the API server after each intraday regime checkpoint (scheduler.ts runRegimeCheckpoints: 15…330 min after the
open). Cheap when nothing moved: one live-price call for the plan's tickers + SPY, no option quotes.

Triggers (any one fires a re-check):
  stock move    |today's move| ≥ Z_TRIGGER × the contract's implied daily move (strike IV / √252), per ticker. Covers every
                L1 survivor of the published plan, so a move can also turn a blocked idea into a pass (richer premium).
  cushion       a listed contract has used ≥ CUSHION_TRIGGER of its distance from the plan's spot to the strike.
  regime        the evidence-based regime rule (Step 4 #8: pause new puts when SPY's 20-session return < pause_puts_spy20)
                flips on the live SPY price vs the last close.
A trigger fires once per ticker per extra 1σ of move (2σ, 3σ, …), once per contract for cushion, once per regime flip a day.

Re-check = verify_plan evaluate --schwab on the published plan (same checks, live Schwab quotes) → publish_model_list
--live-spy (a new append-only Model List run). No re-ranking: candidates and fit scores stay the morning's (S014: the option
score adds ~0 over IV, so intraday re-ranking would churn without evidence). Log: out/intraday/<date>.md.
    .venv/bin/python intraday.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

import params as PM
import rules as R
from build_plan import connect, rows

HERE = Path(__file__).resolve().parent
OUT = HERE / "out" / "intraday"
PY = HERE / ".venv" / "bin" / "python"
EQ_API = "http://127.0.0.1:8080/api/schwab/equity-prices"
Z_TRIGGER = 2.0
CUSHION_TRIGGER = 0.5


def live_prices(tickers: list[str]) -> dict[str, float]:
    req = urllib.request.Request(EQ_API, data=json.dumps({"tickers": tickers}).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return {t: p["price"] for t, p in json.load(r)["prices"].items() if p.get("price")}


def find_triggers(conn, live: dict[str, float], state: dict) -> tuple[list[str], int | None]:
    run = rows(conn, "SELECT id, plan_id FROM watchlist_sync.model_runs ORDER BY id DESC LIMIT 1")
    if not run:
        return [], None
    plan_id = run[0]["plan_id"]
    items = rows(conn, """SELECT ticker, option_type, strike::float8 strike, expiry, model_spot::float8 spot, model_iv::float8 iv, verify_status
                          FROM watchlist_sync.plan_items WHERE plan_id = %s AND l1_pass AND kind = 'option' AND expiry >= CURRENT_DATE""",
                 (plan_id,))
    prev = {r["ticker"]: r["c"] for r in rows(conn, """SELECT DISTINCT ON (ticker) ticker, close::float8 c FROM prices_historical
                                                        WHERE ticker = ANY(%s) AND date < CURRENT_DATE ORDER BY ticker, date DESC""",
                                               (sorted({i["ticker"] for i in items} | {"SPY"}),))}
    fired = []
    # stock move, in implied daily σ (the plan's strike IV for that ticker)
    for t in sorted({i["ticker"] for i in items}):
        px, pc = live.get(t), prev.get(t)
        ivs = [i["iv"] for i in items if i["ticker"] == t and i["iv"]]
        if not (px and pc and ivs):
            continue
        iv = sorted(ivs)[len(ivs) // 2]
        iv = iv / 100 if iv > 5 else iv
        z = (px / pc - 1) / (iv / math.sqrt(252))
        bucket = int(abs(z))
        if abs(z) >= Z_TRIGGER and bucket > state["move"].get(t, 0):
            state["move"][t] = bucket
            fired.append(f"{t} {100 * (px / pc - 1):+.1f}% today = {z:+.1f}σ of its implied daily move")
    # cushion used on listed (passed) contracts
    for i in items:
        px = live.get(i["ticker"])
        if not (px and i["spot"] and (i["verify_status"] or "").startswith("pass")):
            continue
        room = (i["spot"] - i["strike"]) if i["option_type"] == "put" else (i["strike"] - i["spot"])
        used = ((i["spot"] - px) if i["option_type"] == "put" else (px - i["spot"])) / room if room > 0 else 0
        key = f"{i['ticker']}|{i['expiry']}|{i['strike']:g}|{i['option_type']}"
        if used >= CUSHION_TRIGGER and key not in state["cushion"]:
            state["cushion"].append(key)
            fired.append(f"{i['ticker']} {i['strike']:g}{i['option_type'][0].upper()} {i['expiry']}: {100 * used:.0f}% of the cushion used")
    # regime rule flip on live SPY
    import publish_model_list as PUB
    pause_at = PM.champion(conn)[1]["regime"]["pause_puts_spy20"]
    s_close, s_live = PUB.spy_20d(conn), PUB.spy_20d(conn, live.get("SPY"))
    if s_close is not None and s_live is not None:
        paused = s_live < pause_at
        if paused != (s_close < pause_at) and state.get("regime_paused") != paused:
            state["regime_paused"] = paused
            fired.append(f"regime: SPY 20-session {100 * s_live:+.1f}% live → {'market selloff' if paused else 'selloff over'} "
                         f"(below {100 * pause_at:.0f}%; info only — puts are no longer paused, S069: selloff-week puts earned more)")
    return fired, plan_id


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="report triggers; don't re-verify or publish")
    a = ap.parse_args()
    now = datetime.now(R.ET)
    if not R.market_open(now) and not a.dry_run:
        print("skip: market closed")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    sf = OUT / "state.json"
    try:
        state = json.loads(sf.read_text())
    except (OSError, ValueError):
        state = {}
    if state.get("date") != now.date().isoformat():
        state = {"date": now.date().isoformat(), "move": {}, "cushion": []}
    with connect() as conn:
        plan = rows(conn, "SELECT plan_id FROM watchlist_sync.model_runs ORDER BY id DESC LIMIT 1")
        if not plan:
            print("skip: nothing published yet")
            return
        tickers = sorted({r["ticker"] for r in rows(conn, """SELECT ticker FROM watchlist_sync.plan_items
                                                             WHERE plan_id = %s AND l1_pass AND kind = 'option'""", (plan[0]["plan_id"],))} | {"SPY"})
        try:
            live = live_prices(tickers)
        except Exception as e:
            print(f"skip: live prices unavailable ({e})")
            return
        fired, plan_id = find_triggers(conn, live, state)
    if not fired:
        print(f"{now:%H:%M} ET: no trigger ({len(live)} live prices)")
        if not a.dry_run:
            sf.write_text(json.dumps(state))
        return
    print(f"{now:%H:%M} ET: {len(fired)} trigger(s)\n  " + "\n  ".join(fired))
    if a.dry_run:
        return
    steps = [["verify_plan.py", "evaluate", "--schwab", "--plan", str(plan_id)]]
    steps.append(["publish_model_list.py"] + (["--live-spy", str(live["SPY"])] if live.get("SPY") else []))
    results = []
    for args in steps:
        p = subprocess.run([str(PY), *args], cwd=HERE, capture_output=True, text=True, timeout=600)
        tail = (p.stdout + p.stderr).strip().splitlines()[-1:] or [""]
        results.append(f"{args[0]} exit {p.returncode}: {tail[0][:160]}")
        if p.returncode != 0:
            break
    sf.write_text(json.dumps(state))
    with (OUT / f"{now.date()}.md").open("a") as f:
        f.write(f"\n## {now:%H:%M} ET\n" + "".join(f"- {x}\n" for x in fired) + "".join(f"  - {r}\n" for r in results))
    print("\n".join(results))


if __name__ == "__main__":
    main()
