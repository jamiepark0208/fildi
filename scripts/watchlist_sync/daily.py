"""One command for the daily watchlist pipeline. Stops at the first failure; logs every run to out/runs/.

Stages (in order):
  lseg       signals (skips names done today) · price/IV history (incremental, split-aware) · StarMine + earnings history
             (TTL-driven, so usually a skip). All metered against the daily-request and monthly-datapoint guards.
  integrity  split_repair: detect unadjusted splits in prices_historical (two sources) and repair them (backup + log)
  model      fit_model_v14 --write (champion + challengers; writes fit_scores) · build_plan (L1)
  verify     evaluate the Robinhood quotes the export session fetched for today's plan (COLLECT_PROTOCOL Step 13). Optional
             alternative: rh_client.py (deterministic read-only MCP client) if it was ever logged in.
  publish    publish_model_list (Model List in the app) · grade_ledger (grades anything that has expired / matured) ·
             monthly.py (lab + gate re-tests + "wins historically" rebuild, every 28 days; a no-op on other days) ·
             learn propose (new challenger only when evidence moved; promotion stays approval-gated)

Usage: .venv/bin/python daily.py [--from STAGE] [--until STAGE] [--only STAGE] [--verified] [--no-lseg] [--if-needed]
Scheduled (2026-10-11): scripts/maintain.mjs runs `daily.py --if-needed` every morning → full run on trading days when no plan
exists yet for today. With no Robinhood quotes, verify re-prices the plan on Schwab live quotes (verify_plan.schwab_as_raw).
Optional (inside the Robinhood export session): Step 13 `daily.py --until model` + RH quote fetch, Step 14 `daily.py --from verify`.
Run during market hours (LSEG IV and Robinhood quotes are only trustworthy in session).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import rules as R

HERE = Path(__file__).resolve().parent
LSEG = HERE.parents[1] / "research" / "lseg"
PY = HERE / ".venv" / "bin" / "python"
LPY = LSEG / ".venv" / "bin" / "python"
API = HERE.parents[1] / "artifacts" / "api-server"
SH = Path("/bin/sh")   # launchd PATH lacks /opt/homebrew/bin; a failed replay must not abort the plan

STAGES: dict[str, list[tuple[str, Path, Path, list[str]]]] = {
    "lseg": [
        ("signals", LPY, LSEG, ["sync_signals.py"]),
        ("price/IV history", LPY, LSEG, ["sync_daily_history.py"]),
        ("StarMine history", LPY, LSEG, ["sync_starmine_history.py"]),
        ("earnings history", LPY, LSEG, ["sync_earnings_moves.py", "--years", "6"]),
        ("CDS spreads", LPY, LSEG, ["sync_cds.py"]),   # S060: credit flag has no history → collect our own (~5 requests)
    ],
    "integrity": [("split repair", PY, HERE, ["split_repair.py", "--apply"])],
    "model": [
        # S096 tastytrade IV rank/pctile + liquidity → tasty_metrics_daily (+ verify vs LSEG); then the IV-rank resolver
        # (LSEG → tastytrade → none → iv_rank_daily) read by the option scan + fit below. Soft (pipe → exit 0): a failure must not stop the plan; its last line (✗ CHECK / traceback) shows in the log.
        ("tastytrade metrics", SH, HERE, ["-c", f"{PY} tastytrade.py universe 2>&1 | tail -1"]),
        ("IV rank resolver", SH, HERE, ["-c", f"{PY} iv_rank.py 2>&1 | tail -1"]),
        # Jamie 10-20: the noon-PT scan only reached the NEXT morning's plan (~19 h stale) → re-scan with live Schwab quotes first
        ("option scan (live)", SH, API, ["-c", "PATH=/opt/homebrew/bin:$PATH pnpm exec tsx src/scripts/snapshot-option-scores.ts 2>&1 "
                                         "| grep -o 'persisted.*' | tail -1 || echo 'option scan skipped (plan uses the last scan)'"]),
        # Fri accountability used to wait for noon PT dual-write — Mac often asleep by then (10-24). Ride the ≥10:00 ET
        # Model List window (live bids + chains already on disk via option scan). Noon scheduler stays as fallback.
        ("Fri model snapshot", SH, API, ["-c", "PATH=/opt/homebrew/bin:$PATH; "
                                         "dow=$(TZ=America/New_York date +%u); "
                                         "if [ \"$dow\" != 5 ]; then echo 'skip: not Friday ET'; exit 0; fi; "
                                         "pnpm exec tsx src/scripts/run-model-snapshot.ts 2>&1 | tail -5 "
                                         "|| echo 'Fri snapshot failed (noon scheduler / history catch-up can retry)'"]),
        ("fit model", PY, HERE, ["fit_model_v14.py", "--write"]),   # champion + challengers (fit-1.3 is only its input builder)
        # before the plan: build_plan reads today's panic-puts-hiv signals (was after publish → plans used yesterday's, 10-19)
        ("strategy signals", LPY, HERE, ["strategy_signals.py"]),   # A178: panic-puts-hiv live triggers + forward grades
        # S059 put_edge needs this week's put tech components (was monthly only); idempotent per engine digest
        ("tech components", SH, API, ["-c", "PATH=/opt/homebrew/bin:$PATH pnpm exec tsx src/scripts/lab-replay-technicals.ts --freq=week "
                                      f"--from={(date.today() - timedelta(days=7)).isoformat()} 2>&1 | grep lab_tech "
                                      "|| echo 'tech components skipped (put_edge keeps last week, ≤ 10 d)'"]),
        ("band table", PY, HERE, ["band_engine.py", "refresh"]),   # A277 §8 / S101: weekly refit of the sold-put band table (~5 min) — read by build_plan + structures
        ("put recs", PY, HERE, ["put_recs.py"]),   # A277: the one sold-put pick per name → put_recs_daily (Model List, Structures, Rankings, Live)
        ("plan (L1)", PY, HERE, ["build_plan.py"]),
    ],
    "verify": [("evaluate quotes (L2)", PY, HERE, ["verify_plan.py", "evaluate"])],  # quotes come from the export session (Step 13)
    "publish": [
        ("publish Model List", PY, HERE, ["publish_model_list.py"]),
        ("pick odds", PY, HERE, ["pick_odds.py"]),  # A213: per-pick probabilities → watchlist_sync.pick_odds
        ("grade ledger", PY, HERE, ["grade_ledger.py"]),
        ("house view", PY, HERE, ["house_view.py"]),
        ("skew survey", PY, HERE, ["skew_survey.py"]),   # A192 Phase 0: full strike ladders (~120 names) for wing pricing
        ("strategies board", PY, HERE, ["structures.py"]),
        ("put consistency", PY, HERE, ["put_consistency.py"]),   # A277 §3: WARN if a surface shows a different put than the engine   # A192: Rankings › Strategies (≤ 5 names/structure) + ledger grading   # S057/S058: daily odds → forecast ledger + coherence gate on the published list
        ("long-call strategy board", PY, HERE, ["analysis/s086_strategy_board.py"]),   # A244 S086: 11 angles, top 10 each → out/opt/S086_flags.json (angles with analog t ≥ 2)
        ("long-option paper ledger", PY, HERE, ["long_option_ledger.py"]),
        ("S/R strike picker", PY, HERE, ["analysis/s088_sr_zones.py", "--if-due"]),   # S088: weekly refit (~5 min) → sold put/call picks + 1σ baseline → forecast_ledger   # A244 Part C: S081 frozen flags + any passing S083 arm → forecast_ledger sim_structure, graded at expiry (no product, forward track record only)
        ("sim Rec base rates", PY, HERE, ["analysis/sim_rec.py"]),   # A186: labelled sim W-L for names with no graded picks
        ("block audit", PY, HERE, ["analysis/block_audit.py"]),   # were the L2 verify blocks right? (report only)
        ("daily reflection", PY, HERE, ["analysis/daily_reflection.py"]),   # S014: wrong / missed / trader / score IC (report only)
        ("monthly re-test", PY, HERE, ["monthly.py"]),   # no-op unless ≥ 28 days old: lab + gates + win-rate rebuild (~3 min), one summary
        ("learning cycle", PY, HERE, ["learn.py", "propose"]),   # idempotent: only proposes when the evidence moved
    ],
}
ORDER = list(STAGES)


def quotes_ingested() -> bool:
    """Has the latest plan got Robinhood option quotes ingested (by the export session)?"""
    sys.path.insert(0, str(HERE))
    from build_plan import connect, rows
    with connect() as conn:
        r = rows(conn, """SELECT COUNT(*) n FROM watchlist_sync.rh_raw WHERE kind = 'option_quotes'
                          AND plan_id = (SELECT MAX(id) FROM watchlist_sync.plans)""")
    return r[0]["n"] > 0


def full_run_on(d) -> bool:
    """A successful full run (lseg + model stages) that started on ET day d at/after 06:00 ET. Was "any plan built on d (ET)":
    a manual rebuild at 21:22 PT on 10-19 (= 00:22 ET 10-20) made the 10-20 scheduled run skip → no LSEG sync, no live option
    scan, no fit (Claude 10-20). Manual rebuild.sh plans (build_plan only) no longer count."""
    for f in (HERE / "out" / "runs").glob("*.json"):
        try:
            log = json.loads(f.read_text())
            started = datetime.fromisoformat(log["started"]).astimezone(R.ET)   # naive = Mac local time
        except (ValueError, KeyError, OSError):
            continue
        if (started.date() == d and started.hour >= 6 and log.get("status") in ("ok", "awaiting_verification")
                and {"lseg", "model"} <= set(log.get("stages", []))):
            return True
    return False


def run(name, py, cwd, args) -> dict:
    t0 = time.time()
    p = subprocess.run([str(py), *args], cwd=cwd, capture_output=True, text=True, timeout=1800,
                       env={**os.environ, "LSEG_PRIORITY": "1"})  # production: LSEG reserve over research pulls
    out = "\n".join(l for l in (p.stdout + p.stderr).splitlines() if "Warning" not in l)
    tail = "\n".join(out.splitlines()[-4:])
    return {"step": name, "ok": p.returncode == 0, "code": p.returncode, "seconds": round(time.time() - t0, 1), "tail": tail}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--from", dest="start", choices=ORDER, default="lseg")
    ap.add_argument("--only", choices=ORDER)
    ap.add_argument("--until", choices=ORDER, help="stop after this stage (the export session runs --until model, then fetches quotes)")
    ap.add_argument("--verified", action="store_true", help="Robinhood L2 data has been ingested for the latest plan")
    ap.add_argument("--no-lseg", action="store_true")
    ap.add_argument("--if-needed", action="store_true", help="scheduled run: skip unless a trading day with no plan built today (ET)")
    a = ap.parse_args()
    if a.if_needed:
        today = datetime.now(R.ET).date()
        if not R.is_trading_day(today):
            print(f"skip: {today} is not a trading day")
            return
        if full_run_on(today):
            print(f"skip: a full run already finished on {today} (ET)")
            return
        if not R.market_open():
            # launchd fires a missed 7 AM job on wake; after the close that would publish on after-hours quotes (10-20:
            # 5 of 6 puts failed L2 on spreads). Keep yesterday's in-session list; data_freshness flags the missed day.
            print(f"skip: market closed — the scheduled run needs in-session quotes; next session builds the list")
            return
    stages = [a.only] if a.only else ORDER[ORDER.index(a.start):(ORDER.index(a.until) + 1 if a.until else None)]
    if a.no_lseg:
        stages = [s for s in stages if s != "lseg"]
    if not R.market_open():
        print("note: market is closed. LSEG IV and Robinhood quotes are only trustworthy in session (yellow tags / L2 would be provisional)")
    log = {"started": datetime.now().isoformat(timespec="seconds"), "stages": stages, "steps": []}
    status = "ok"
    for st in stages:
        if st == "verify" and not a.verified and not quotes_ingested():
            # quotes normally arrive from the Robinhood export session (COLLECT_PROTOCOL Step 13); the optional deterministic
            # client is used only if it was ever logged in (rh_client.py login)
            login = subprocess.run([str(PY), "rh_client.py", "status"], cwd=HERE, capture_output=True, text=True)
            if login.returncode == 0:
                STAGES["verify"] = [("Robinhood quotes (rh_client)", PY, HERE, ["rh_client.py", "fetch"])]
            # else: verify_plan evaluate re-prices on Schwab live quotes (exit 3 if Schwab is unavailable too)
        for name, py, cwd, args in STAGES[st]:
            r = run(name, py, cwd, args)
            log["steps"].append(r)
            print(f"{'✓' if r['ok'] else '✗'} {st:<9} {name:<24} {r['seconds']:>6}s  {r['tail'].splitlines()[-1] if r['tail'] else ''}"[:220])
            if not r["ok"] and st == "lseg":
                # LSEG Workspace must be running for these; without it, continue on the last synced data (logged)
                log.setdefault("warnings", []).append(f"{name} failed; continuing on last synced LSEG data")
                print(f"  ↳ continuing without fresh LSEG data ({r['tail'].splitlines()[-1][:120] if r['tail'] else ''})")
                continue
            if st == "verify" and r["code"] == 3:
                status = "awaiting_verification"
                print("→ no Robinhood quotes and Schwab unavailable: plan built but not verified/published; re-run `daily.py --from verify`")
                break
            if not r["ok"]:
                status = f"failed at {name}"
                print(r["tail"])
                break
        if status != "ok":
            break
    if status.startswith("failed"):   # 10-19: a crash left Jamie on Friday's list silently → the gate records it as STALE
        r = run("house view", PY, HERE, ["house_view.py", "--no-log"])
        log["steps"].append(r)
    log["status"] = status
    out = HERE / "out" / "runs"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{datetime.now():%Y%m%d_%H%M%S}.json").write_text(json.dumps(log, indent=1))
    print(f"status: {status}")
    sys.exit(0 if status in ("ok", "awaiting_verification") else 1)


if __name__ == "__main__":
    main()
