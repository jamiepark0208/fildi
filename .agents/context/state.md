# TradeDash — Current State

> Update this file at the end of each session (or run `.claude/scripts/session-wrap.js`). Finished sections → `state-archive.md` (verbatim history).

## Phase
**build** — last updated 2026-10-14

## Active work
- Working: api-llm-optimization-pass, blended-fair-value-fv-1.0.0, fund-1.1.0-ibesFwdGrowth, fair-value-maintain-health-checks, value-trap-flag, cyclical-confidence-cap, model-list-strike-vs-fair
- In progress: fair-value-snapshot-history-accruing
- Blocked: none

## Next tasks (priority order)

0. **PM agent (user 2026-10-14: Claude = PM, Cursor = dev, Muse = ideation).** S015 (08b8ce6): picks fine, assignment EV-neutral, breaches cluster. Built: `pm_book.py` (--live Schwab) + `pm_alerts.py` (probabilistic: market-IV P(assign), calibrated on 926 puts 18% pred vs 21% real n.s.; one-factor ρ=0.6 fits S015 clustering; 20k-path P(margin call); thresholds 10%/30% defaults) → table `watchlist_sync.pm_alerts` → `GET /api/pm/alerts` → **Live › Portfolio Alerts** tab. LaunchAgent `com.fildi.pm-alerts` (15 min mkt hours, 2 h otherwise). **No push/email** (user deleted email bridge 10-14; no crazy alerts). User decisions 10-14: crash budget 25% red / 20% amber; Claude plan-reviews every Muse row. Declined A47/A51/A57; A74 narrowed; A75 v2 (all sources probed: RH Trading MCP reads all accounts = live book, Schwab expirationchain = Model List unblock, Polygon free option EOD bars, FMP symbol-restricted, Polygon financials GONE); A72 v2 (G1: Mac mini vs Oracle). Pending user: RH MCP setup (Agentic acct unfunded), A72 G1, Model List expirationchain scan OK. A76 left for Cursor: Book card + Expiry what-if. **10-14 later:** Model List re-prices Friday picks daily from option_chain_history, rolling when < 2 DTE (b99a17d; puts L1 0 → 14, user approved). transcripts.py (AV ≤ 20/day, Haiku summaries; LaunchAgent com.fildi.transcripts 05:30) + Your names (SI from LSEG short_pct, earnings, call summary) in Portfolio Alerts. Endpoint matrix: .agents/context/data-source-fields/endpoint-entitlements.md. A72 v3 = Oracle free + laptop pushes LSEG/RH (no hardware). A84 bugs → Cursor. Breakdown panels: Short interest (Polygon FINRA history + LSEG % float; `short_interest_history`) and Earnings call (transcripts schema v2: guidance items vs prior vs Street, model inputs, KPIs, tone script/Q&A + trend, analyst pushback; book names back-fill 3 prior quarters). Oracle tenancy already exists (FactSet proxy micro VM); user waits on A72.

1. **Model List live grades** — first expiries 2026-10-09..12: grade vs win-rate table, then A24 (RH trade tiers → learn.py).
2. **fair value re-test** — after ~6 months of `fair_value_snapshots` (see memory fair-value).
3. **Model List automation (ed25aae, 2026-10-11)** — maintain 07:00 runs `daily.py --if-needed`; verify on Schwab when no RH quotes; `intraday.py` after each regime checkpoint (≥2σ move / ≥50% cushion / SPY pause flip → re-verify + republish). LSEG works (probe 10/11 OK; synced 271 names). PENDING: user Schwab re-auth (`node --env-file=.env.local scripts/schwab-oauth.mjs`), API-server restart, then full verify+publish test on plan #7+ and first live intraday run Monday. **10/14 status:** automation runs (plans #8 10/12, #9 10/13 built; intraday fired 10/13–14 on POET/CAVA) but every verify exits 3 because Schwab is still logged out → Model List still shows run #19 (plan #3, 10/06). No plan built 10/14 yet: check maintain-last.json `modelList`. Fix = user Schwab re-auth, then `daily.py --from verify` on the latest plan. **10/14 PM:** Schwab re-authed (obtainedAt 2026-10-14T21:19Z, valid to ~10/21). Root cause of the "re-auth didn't take": `lib/schwab-auth.ts` cached tokens in memory and failed refreshes wrote the stale copy back over new tokens → fixed (mtime re-read + `saveError` skips when disk refresh_token changed); `schwab-oauth.mjs` now exits after save. Both uncommitted. NEW BLOCKER: plan #10 has 0 options: `fresh_snapshot` gate (rules.py MAX_SNAPSHOT_AGE_TRADING_DAYS=1) vs model_recs written only Fri (model-snapshot job) → Wed–Fri plans never have options. Needs user decision (daily snapshot vs gate). Before/after 10/14 (scratch, not built): daily snapshots double-count the track record; `option_score_snapshots` (daily ~12:45 PT, same pickBestStrike+tilt) fixes freshness but on Wed/Thu picks this-week expiry (204/249 at 1 DTE) → dte_band blocks; only 8 puts pass (2 inside the model_recs universe), 0 calls. Real fix = target-expiry chain scan (next-week expiry) for Wed–Fri builds, same as Phase 2 per-ticker scan. Also 35/46 Friday puts fail spot_drift by Wed. Phase 2 (not built): new per-ticker recs after big moves (S011 dip-timing evidence) needs a per-ticker chain scan.
4. **S014 reflection** — accumulate to ≥ 8 expiries / ≥ 100 ideas before any option_score claim; found_wrong log re-counts the same contract daily (dedupe TODO).
5. Block audit grades (first 10/09) · re-run timing study after ≥ 100 new trades · exit-rule study once option_chain_history ≥ 3 months.

## Open facts worth keeping (details in state-archive.md)
- RH accounts: IRA `772445425` = the strategy (judge the model here); FILDI `5QU47796` = mixed → rebalance recs.
- Fildi premium = Schwab/Yahoo **bid**; RH realistic fill = bid + 10–36% of spread (median ~23%).
- S014 so far: option_score adds ~0 over IV (IV-fixed IC ≈ 0); put raw IC negative (high score = high IV).
- Daily bars: Schwab → Yahoo (thin/stale only) → LSEG soft; coverage alert < 95%. Option snapshots keep calendar asOf on purpose.
- Not done from 10/06: DB backfill of snapshot 13 avg cost (next export ingest fixes). Rec-quality fixes not browser-verified.
- Fundamentals (07-23): residual ~1017 Needs Review = genuine vendor disagreement; backfill order: api_usage budget → fmp → polygon → av.

## FactSet Proxy — LIVE ✅
- Oracle Cloud VM `146.235.223.94` (Always Free, IP reserved). SSH: `ssh -i ~/Desktop/ssh-key-2026-06-14.key ubuntu@146.235.223.94`; logs `pm2 logs factset-proxy --lines 30 --nostream`
- Account `USCMARSHALL-2393811` (Overview Report Builder only): `GET /report/overview/v1/financial-highlights?id=TICKER-US`. FMP fills PE/PB/PS/ROIC/Beta/WACC/targets/debt/shares.
- DB-first cache, 7-day freshness; only `POST /api/sdm/refresh/:ticker?admin=true` forces a live call.

## RSI / MFI thresholds
Per-ticker thresholds: `.claude/skills/signal-filters.md` (authoritative). MFI threshold: 25 (all tickers).

## Watchlist recommendations (Claude, 2026-10-05)
Live: app Watchlist → **Model List** tab (champion `fit-1.4.1` from `watchlist_sync.model_params`). Updated by the RH export session (COLLECT_PROTOCOL Steps 13–14 → `scripts/watchlist_sync/daily.py`). Learning loop `learn.py`. Details: `scripts/watchlist_sync/NEXT_SESSION.md`.

## Review loop + ASKS format (2026-10-11, user YES)
AGENTS.md § Review loop. Claude: plan-review `[quant]` Muse rows → `planned`; review quant commits (`Refs: A##`) before reading Muse's review; never implement Muse rows.
ASKS.md = one-line index; details/reviews in `research/common/asks/A##.md`. A47, A49, A51–A57 `[quant]` + `planned` (plan notes copied into each file from A59).
Last reviewed SHA: 4acb1ad (later commits fb50e09, eab4c14 + this one are Claude workflow-only)
