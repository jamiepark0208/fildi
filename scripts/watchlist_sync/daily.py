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
import fcntl
import json
import os
import signal
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
        ("LSEG ids", LPY, LSEG, ["sync_ids.py", "--missing"]),   # 10-27: 422 universe names had no RIC → every LSEG sync skipped them
        ("LSEG coverage", LPY, LSEG, ["coverage.py"]),   # 10-27: follows the universe + option chain (was never re-run → RDDT gap)
        ("peer profiles", LPY, LSEG, ["peer_profiles.py"]),   # 10-27: LSEG description + TRBC for names without a reviewed peer group
        ("signals", LPY, LSEG, ["sync_signals.py"]),
        ("consensus by year", LPY, LSEG, ["sync_consensus.py"]),   # A283: FY0 actual + FY1–FY3 revenue/EBIT → consensus_annual (DCF years 1–3; ~19 requests)
        # new names start 2024-10 (~500 bars: put-edge, zones, band engine); 2020 for hundreds of new names ≈ 5.6M datapoints
        ("price/IV history", LPY, LSEG, ["sync_daily_history.py", "--start", "2024-10-01"]),
        ("StarMine history", LPY, LSEG, ["sync_starmine_history.py"]),
        ("earnings history", LPY, LSEG, ["sync_earnings_moves.py", "--years", "6"]),
        ("CDS spreads", LPY, LSEG, ["sync_cds.py"]),   # S060: credit flag has no history → collect our own (~5 requests)
    ],
    "integrity": [("split repair", PY, HERE, ["split_repair.py", "--apply"])],
    "model": [
        ("peer check", PY, HERE, ["peer_verify.py", "--apply"]),   # 10-27: OpenJev + TRBC + co-movement; 2 of 3 agree → verified (enters peer norms)
        # S096 tastytrade IV rank/pctile + liquidity → tasty_metrics_daily (+ verify vs LSEG); then the IV-rank resolver
        # (LSEG → tastytrade → none → iv_rank_daily) read by the option scan + fit below. Soft (pipe → exit 0): a failure must not stop the plan; its last line (✗ CHECK / traceback) shows in the log.
        ("tastytrade metrics", SH, HERE, ["-c", f"{PY} tastytrade.py universe 2>&1 | tail -1"]),
        ("IV rank resolver", SH, HERE, ["-c", f"{PY} iv_rank.py 2>&1 | tail -1"]),
        # A283: outside intrinsic values (StarMine from today's LSEG signals; FMP DCF weekly, ≤ 40 calls) → external_intrinsic. Soft.
        ("outside intrinsic values", SH, HERE, ["-c", f"{PY} dcf/external_iv.py --max 40 2>&1 | tail -1"]),
        # A289: DCF v2 lab detail (watchlist only until fv-2.0.0 is signed) → dcf_detail → Breakdown › Assumptions. Soft.
        ("DCF lab (watchlist)", SH, HERE, ["-c", f"{PY} ../../research/fair_value/dcf_watch.py --store 2>&1 | tail -1"]),
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
        ("vix", PY, HERE, ["vix_daily.py"]),   # 10-29 B16: Yahoo VIX/VIX3M daily — wrds cboe_daily lags ~a week (10-23 on 10-29)
        ("sector ETFs", PY, HERE, ["sector_etfs.py"]),   # A277: 49 sector/theme ETF closes (SOXX, REMX, SRVR …) → per-name sector_drop state
        ("band table", PY, HERE, ["band_engine.py", "refresh"]),   # A277 §8 / S101: weekly refit of the sold-put band table (~5 min) — read by build_plan + structures
        ("indicators", PY, HERE, ["indicators.py"]),   # A279: UT Bot / SuperTrend cluster / SMC / Fear & Greed per name → indicators_daily (display; S102)
        ("turning points", SH, HERE, ["-c", f"{PY} turning_points.py 2>&1 | tail -2 || echo 'turning points skipped'"]),  # A330: S151 odds → turning_point_scores (soft)
        ("put edge", PY, HERE, ["put_edge.py"]),   # today's quintiles before the engine reads them (10-28: it read yesterday's)
        ("put recs", PY, HERE, ["put_recs.py"]),
        ("put manage", PY, HERE, ["put_manage.py"]),   # A279 / S103: open short puts → take + re-sell at ≥ 4× pace (weeklies), else hold; never trend stops   # A277: the one sold-put pick per name → put_recs_daily (Model List, Structures, Rankings, Live)
        ("plan (L1)", PY, HERE, ["build_plan.py"]),
    ],
    "verify": [("evaluate quotes (L2)", PY, HERE, ["verify_plan.py", "evaluate"])],  # quotes come from the export session (Step 13)
    "publish": [
        ("publish Model List", PY, HERE, ["publish_model_list.py"]),
        ("pick odds", PY, HERE, ["pick_odds.py"]),  # A213: per-pick probabilities → watchlist_sync.pick_odds
        ("grade ledger", PY, HERE, ["grade_ledger.py"]),
        ("house view", PY, HERE, ["house_view.py"]),
        # Jamie 10-29: Trading Central valuation/levels/outlooks + Argus PT + Morningstar bull/bear text (Yahoo insights, free,
        # ~1.2 s/name sequential, circuit-aware) → yahoo_insights_daily (+ argus_pt in external_intrinsic). Soft.
        # 11-03: after publish — nothing that builds the list reads it (fair value is display-only); was ~21 min ahead of the list.
        ("Yahoo insights (Trading Central)", SH, API, ["-c", "PATH=/opt/homebrew/bin:$PATH pnpm exec tsx src/scripts/sync-yahoo-insights.ts 2>&1 "
                                                       "| grep 'yahoo-insights:' | tail -1 || echo 'yahoo insights skipped'"]),
        ("DCF grades", SH, HERE, ["-c", f"{PY} dcf/grade.py 2>&1 | tail -1"]),   # A283 step 2: rank IC vs fv-1.x / StarMine, drift, stability (reads Trading Central/Argus → after it)
        # Key Themes (Jamie 10-28): Treasury cash flows → gov_flows_*; then the themes snapshot (signposts + unified read →
        # theme_snapshots, graded on each view's check date). Soft: a failure must not stop the plan.
        ("gov flows", SH, HERE, ["-c", f"{PY} gov_flows.py 2>&1 | tail -1"]),
        ("geo risk + oil", SH, HERE, ["-c", f"{PY} geo_risk.py 2>&1 | tail -1"]),   # GPR index (Fed Board) + FRED WTI/Brent → macro_daily
        ("key themes snapshot", SH, API, ["-c", "PATH=/opt/homebrew/bin:$PATH pnpm exec tsx src/scripts/snapshot-themes.ts 2>&1 | tail -1"]),
        ("dealer GEX log", SH, API, ["-c", "PATH=/opt/homebrew/bin:$PATH pnpm exec tsx src/scripts/snapshot-gex-daily.ts 2>&1 | tail -3"]),
        ("skew survey", PY, HERE, ["skew_survey.py"]),   # A192 Phase 0: full strike ladders (~120 names) for wing pricing
        # 10-28: Live-tab regime checkpoints were never graded (table missing, no schedule) → grade the last 3 sessions daily.
        # 40-day backfill: bearish right 77 / wrong 121, bullish 117 / 108 — no edge yet; the grade table is how we'd know.
        ("regime grades", SH, API, ["-c", "PATH=/opt/homebrew/bin:$PATH pnpm exec tsx src/scripts/backfill-intraday-history.ts 3 2>&1 "
                                    "| grep -o 'graded.*' | tail -1 || echo 'regime grades skipped'"]),
        ("strategies board", PY, HERE, ["structures.py"]),
        ("put consistency", PY, HERE, ["put_consistency.py"]),   # A277 §3: WARN if a surface shows a different put than the engine   # A192: Rankings › Strategies (≤ 5 names/structure) + ledger grading   # S057/S058: daily odds → forecast ledger + coherence gate on the published list
        ("revisions from LSEG", PY, HERE, ["analysis/lab_fund_lseg.py"]),   # 11-09: WRDS IBES ends 08-20 → ibes_drift/_3m/breadth/disp/fwd_growth from LSEG signals_daily for the board
        ("long-call strategy board", PY, HERE, ["analysis/s086_strategy_board.py"]),   # A244 S086: 11 angles, top 10 each → out/opt/S086_flags.json (angles with analog t ≥ 2)
        ("long-option paper ledger", PY, HERE, ["long_option_ledger.py"]),
        ("S171 paper calls", PY, HERE, ["s171_paper.py"]),   # A244 S171: loss-maker momentum ∧ cheap vol → 30 DTE 0.30Δ call at the ask, graded day 3 vs same-Δ stock
        ("S172 bottom signal", PY, HERE, ["s172_paper.py"]),   # S172: VIX÷VIX3M un-invert → SPY/QQQ/IWM 0.50Δ calls (paper, to expiry) + SPY/QQQ 0.20Δ put signals
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


STEP_TIMEOUT_S = 1800

# 11-03 failure causes (first match wins) → what the scheduler does next. A blind retry re-ran the whole chain into the same
# wall; now: network/vendor outage → defer (attempt refunded), auth → needs Jamie, code error → needs an agent, timeout →
# resume at that step next attempt.
CAUSES = [
    ("network", r"ENOTFOUND|getaddrinfo|EADDRNOTAVAIL|ECONNREFUSED|ENETUNREACH|Network is unreachable|nodename nor servname|"
                r"Temporary failure in name resolution|No route to host|fetch failed"),
    ("auth", r"\b401\b|Unauthorized|refresh token|invalid_grant|re-?auth|login required|Duo"),
    ("vendor", r"\b(429|502|503|504)\b|rate limit|circuit open|vendor unreachable|ReadTimeout|timed out"),
    ("code", r"Traceback \(most recent call last\)|SyntaxError|TypeError|NameError|AttributeError|KeyError|ImportError|ModuleNotFoundError"),
]


def cause_of(r: dict) -> str:
    if r["ok"]:
        return "ok"
    if r["code"] == 124:
        return "timeout"
    import re
    for cause, pat in CAUSES:
        if re.search(pat, r.get("full") or r["tail"] or ""):
            return cause
    return "other"


def run(name, py, cwd, args) -> dict:
    t0 = time.time()
    try:
        # own process group: 11-09 a timed-out step ran 4,242 s past its 1,800 s cap — kill() hit only the direct child and
        # communicate() then waited on pipes a grandchild still held. killpg ends the whole tree at the cap.
        p = subprocess.Popen([str(py), *args], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             env={**os.environ, "LSEG_PRIORITY": "1"}, start_new_session=True)  # production: LSEG reserve
        try:
            so, se = p.communicate(timeout=STEP_TIMEOUT_S)
            code, raw = p.returncode, (so or "") + (se or "")
        except subprocess.TimeoutExpired:   # 11-03: was uncaught → daily.py died with no run log
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                so, se = p.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                so, se = "", ""
            code = 124
            raw = (so or "") + (se or "") + f"\ntimeout after {STEP_TIMEOUT_S}s"
    except OSError as e:
        code, raw = 127, f"could not start: {e}"
    out = "\n".join(l for l in raw.splitlines() if "Warning" not in l)
    tail = "\n".join(out.splitlines()[-4:])
    r = {"step": name, "ok": code == 0, "code": code, "seconds": round(time.time() - t0, 1), "tail": tail, "full": out[-6000:]}
    r["cause"] = cause_of(r)
    r.pop("full")
    return r


def inflight_path(day) -> Path:
    return HERE / "out" / "runs" / f"inflight-{day}.json"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--from", dest="start", choices=ORDER, default="lseg")
    ap.add_argument("--only", choices=ORDER)
    ap.add_argument("--until", choices=ORDER, help="stop after this stage (the export session runs --until model, then fetches quotes)")
    ap.add_argument("--verified", action="store_true", help="Robinhood L2 data has been ingested for the latest plan")
    ap.add_argument("--no-lseg", action="store_true")
    ap.add_argument("--if-needed", action="store_true", help="scheduled run: skip unless a trading day with no plan built today (ET)")
    a = ap.parse_args()
    # 11-03: one run at a time — a manual run and maintain's retry must never build/publish two plans at once
    lock = open(HERE / "out" / "daily.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("skip: another daily.py run is in progress")
        sys.exit(75)   # not 0: maintain must not count the day as done while the other run may still fail
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
    # 11-03 resume: a scheduled run picks up today's interrupted run (killed / timed out / deferred) at the first step that
    # did not finish, instead of re-running ~1 h of done steps. A code failure is not resumed blindly: the failed step re-runs.
    day = datetime.now(R.ET).date()
    inflight = inflight_path(day)
    done: set[str] = set()
    log = {"started": datetime.now().isoformat(timespec="seconds"), "stages": stages, "steps": []}
    if a.if_needed and inflight.is_file():
        try:
            prev = json.loads(inflight.read_text())
            if prev.get("stages") == stages:
                log = {**prev, "resumed": prev.get("resumed", 0) + 1}
                done = {x["step"] for x in prev.get("steps", []) if x.get("ok")}
                print(f"resume: {len(done)} step(s) already done today (attempt {log['resumed'] + 1})")
        except (ValueError, OSError):
            pass

    def save_inflight() -> None:
        inflight.parent.mkdir(parents=True, exist_ok=True)
        inflight.write_text(json.dumps({**log, "status": "running"}, indent=1))

    status = "ok"
    cause = "ok"
    for st in stages:
        if st == "verify" and not a.verified and not quotes_ingested():
            # quotes normally arrive from the Robinhood export session (COLLECT_PROTOCOL Step 13); the optional deterministic
            # client is used only if it was ever logged in (rh_client.py login)
            login = subprocess.run([str(PY), "rh_client.py", "status"], cwd=HERE, capture_output=True, text=True)
            if login.returncode == 0:
                STAGES["verify"] = [("Robinhood quotes (rh_client)", PY, HERE, ["rh_client.py", "fetch"])]
            # else: verify_plan evaluate re-prices on Schwab live quotes (exit 3 if Schwab is unavailable too)
        for name, py, cwd, args in STAGES[st]:
            if name in done:
                print(f"↷ {st:<9} {name:<24} done earlier today")
                continue
            r = run(name, py, cwd, args)
            log["steps"].append(r)
            save_inflight()
            print(f"{'✓' if r['ok'] else '✗'} {st:<9} {name:<24} {r['seconds']:>6}s  {r['tail'].splitlines()[-1] if r['tail'] else ''}"[:220])
            # 10-28: a surface showing another put / an unscored pick must reach the run log, not scroll by
            log.setdefault("warnings", []).extend(l for l in (r["tail"] or "").splitlines() if l.startswith("WARN put consistency"))
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
                cause = r["cause"]
                status = f"failed at {name} ({cause})"
                print(r["tail"])
                break
        if status != "ok":
            break
    if status.startswith("failed"):   # 10-19: a crash left Jamie on Friday's list silently → the gate records it as STALE
        r = run("house view", PY, HERE, ["house_view.py", "--no-log"])
        log["steps"].append(r)
    log["status"] = status
    log["cause"] = cause
    out = HERE / "out" / "runs"
    out.mkdir(parents=True, exist_ok=True)
    if status in ("ok", "awaiting_verification"):
        (out / f"{datetime.now():%Y%m%d_%H%M%S}.json").write_text(json.dumps(log, indent=1))
        inflight.unlink(missing_ok=True)
    else:
        # keep the in-flight log so the next attempt resumes; also a dated copy for the record
        log_failed = {**log, "steps": [x for x in log["steps"] if x["step"] != "house view"]}
        inflight.write_text(json.dumps({**log_failed, "status": status}, indent=1))
        (out / f"{datetime.now():%Y%m%d_%H%M%S}.json").write_text(json.dumps(log, indent=1))
    print(f"status: {status}")
    print(f"cause: {cause}")
    # exit: 0 ok · 75 deferred (network / vendor outage: retry later, attempt refunded) · 2 needs action (auth → Jamie,
    # code error → agent; retrying cannot fix it) · 1 other failure / timeout (next attempt resumes at the failed step)
    if status in ("ok", "awaiting_verification"):
        sys.exit(0)
    sys.exit({"network": 75, "vendor": 75, "auth": 2, "code": 2}.get(cause, 1))


if __name__ == "__main__":
    main()
