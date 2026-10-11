# TradeDash — Current State

> Update this file at the end of each session (or run `.claude/scripts/session-wrap.js`). Finished sections → `state-archive.md` (verbatim history).

## Phase
**build** — last updated 2026-10-11

## Active work
- Working: api-llm-optimization-pass, blended-fair-value-fv-1.0.0, fund-1.1.0-ibesFwdGrowth, fair-value-maintain-health-checks, value-trap-flag, cyclical-confidence-cap, model-list-strike-vs-fair
- In progress: fair-value-snapshot-history-accruing
- Blocked: none

## Next tasks (priority order)

1. **Model List live grades** — first expiries 2026-10-09..12: grade vs win-rate table, then A24 (RH trade tiers → learn.py).
2. **fair value re-test** — after ~6 months of `fair_value_snapshots` (see memory fair-value).
3. **Model List automation (ed25aae, 2026-10-11)** — maintain 07:00 runs `daily.py --if-needed`; verify on Schwab when no RH quotes; `intraday.py` after each regime checkpoint (≥2σ move / ≥50% cushion / SPY pause flip → re-verify + republish). LSEG works (probe 10/11 OK; synced 271 names). PENDING: user Schwab re-auth (`node --env-file=.env.local scripts/schwab-oauth.mjs`), API-server restart, then full verify+publish test on plan #7+ and first live intraday run Monday. Phase 2 (not built): new per-ticker recs after big moves (S011 dip-timing evidence) needs a per-ticker chain scan.
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
