# TradeDash — Current State

> Update this file at the end of each session (or run `.claude/scripts/session-wrap.js`). Finished sections → `state-archive.md` (verbatim history).

## Phase
**build** — last updated 2026-10-29

## Active work

## Standing (pinned — state_rotate never moves these; edit by hand, remove when done)
- **Unfinished, partial work uncommitted in tree (agents died at session limit):** cache monitor rebuild (ttl-cache.ts counters, cache-registry.ts, new cache-overview.ts) · A126 charts (early) · finish one at a time, inline or ONE sonnet agent (CLAUDE.md subagent budget rule). Not mine: GROK.md, A140, CONVENTIONS.md, cursor-usage-snap.mjs, A131/A122 edits.
- Cache: keep Mac caches (Jamie 10-16). S033 (HAR vs RV20) still the biggest score lever, not started.
- **Model List live grades** — first expiries 2026-10-09..12: grade vs win-rate table, then A24 (RH trade tiers → learn.py).
- **fair value re-test** — after ~6 months of `fair_value_snapshots` (see memory fair-value).
- **S014 reflection** — accumulate to ≥ 8 expiries / ≥ 100 ideas before any option_score claim; found_wrong log re-counts the same contract daily (dedupe TODO).
- Block audit grades (first 10/09) · re-run timing study after ≥ 100 new trades · exit-rule study once option_chain_history ≥ 3 months.
- User decisions 10-14 (from the PM-agent log, full text in state-archive.md): Claude = PM, Cursor = dev, Muse = ideation; crash budget 25 % red / 20 % amber; no push/email alerts (email bridge deleted); Claude plan-reviews every Muse row; FILDI accounts with a margin loan get no new put ideas (10-06, S012).

## Next tasks (priority order)
- **11-07 12:30 Claude:** A362 done (4f9e87ae pass + Claude fix 2854843f: net_mid column printed cross). Corrected verdict: intraday 5m RSI-dip short puts net negative in every cell at mid; RSI<5 lift +20–31 bp = context only. A192 Phase 0 skew fit FAIL (2.69 vs 2 vol pts) → v3 = price legs off stored live quotes; skew_survey now keeps SPY/QQQ/IWM (were dropped since 10-28). RUNNING: A359 fix4 (Cursor composer-2.5, spec now has A362 baseline + deep_otm fallback fix + A188 overnight-carry cell). NEXT: fix4 packet review; write A192 plan v3; A184 library run after fix4 (one code edit at a time).
- **11-07 11:45 Claude:** RUNNING 2 Cursor composer-2.5: A362-fix (full after-run, pid 7759, log /tmp/fildi-logs/dispatch/1107-112215-60060206.jsonl) and A192 Phase 0 skew fit (`.agents/dispatch/A192-p0-skewfit.md`, pass MAE ≤ 2 vol pts). Done: 2fdd403e reviewed (pass + deep_otm fallback note), A195 declined + archived, A208 → Cursor, A188 #1 = A359 overnight carry test after fix4. NEXT: review A362 packet (smoke points above) → fix4; A192 packet → plan v3; A184 library run when fast_screen free.
- **Open threads carried from 11-06/11-07 (full entries → state-archive.md "rotated 11-07 12:45"):** Cursor queue after fix4, one at a time: A318 build → A367 follow-up (loaders → plan_fetch, agent_start prints skipped_new) → A364/A357 (commit Cursor's uncommitted A357 files first; LSE backfill cut to per-week top tercile + equal random same-delta sample, newest weeks first) → A365 (test vs S159 via A359 engine) / A366. Dated checks: A367 after-numbers 11-11 (pg_stat churn vs Before in A367.md); A327 live check 11-13 (gate audit rows, 0 churn promotions). Research next: S159 → short puts on SPY/QQQ RSI14<25 days on real chains (A359 engine); A352 ex-ante group-cap trigger study; A341/A330 shadow promotion trigger = ≥ 100 live top-tier tagged picks, add > 0, t ≥ 2; A359 § 5 factor model. Stalled triage left: A219 A230 A233 A234 A246 A262 A270 (A246 ≈ fast_screen promote loop; A270 GARCH = S033 lever).

## Open facts worth keeping (details in state-archive.md)
- RH accounts: IRA (acct # in ~/.fildi/private.md) = the strategy (judge the model here); FILDI (acct #) = mixed → rebalance recs.
- Fildi premium = Schwab/Yahoo **bid**; RH realistic fill = bid + 10–36% of spread (median ~23%).
- S014 so far: option_score adds ~0 over IV (IV-fixed IC ≈ 0); put raw IC negative (high score = high IV).
- Daily bars: Schwab → Yahoo (thin/stale only) → LSEG soft; coverage alert < 95%. Option snapshots keep calendar asOf on purpose.
- Not done from 10/06: DB backfill of snapshot 13 avg cost (next export ingest fixes). Rec-quality fixes not browser-verified.
- Fundamentals (07-23): residual ~1017 Needs Review = genuine vendor disagreement; backfill order: api_usage budget → fmp → polygon → av.

## FactSet Proxy — LIVE ✅
- Oracle Cloud VM (IP in ~/.fildi/private.md) (Always Free, IP reserved). SSH: see ~/.fildi/private.md; logs `pm2 logs factset-proxy --lines 30 --nostream`
- Account (id in ~/.fildi/private.md) (Overview Report Builder only): `GET /report/overview/v1/financial-highlights?id=TICKER-US`. FMP fills PE/PB/PS/ROIC/Beta/WACC/targets/debt/shares.
- DB-first cache, 7-day freshness; only `POST /api/sdm/refresh/:ticker?admin=true` forces a live call.

## RSI / MFI thresholds
Per-ticker thresholds: `.claude/skills/signal-filters.md` (authoritative). MFI threshold: 25 (all tickers).

## Watchlist recommendations (Claude, 2026-10-05)
Live: app Watchlist → **Model List** tab (champion `fit-1.4.1` from `watchlist_sync.model_params`). Updated by the RH export session (COLLECT_PROTOCOL Steps 13–14 → `scripts/watchlist_sync/daily.py`). Learning loop `learn.py`. Details: `scripts/watchlist_sync/NEXT_SESSION.md`.

## Review loop + ASKS format (2026-10-11, user YES)
AGENTS.md § Review loop. Claude: plan-review `[quant]` Muse rows → `planned`; review quant commits (`Refs: A##`) before reading Muse's review; never implement Muse rows.
ASKS.md = one-line index; details/reviews in `research/common/asks/A##.md`. A47, A49, A51–A57 `[quant]` + `planned` (plan notes copied into each file from A59).

Last reviewed SHA: c9b09224 (11-07 late: 2fdd403e fix3b pass + deep_otm fallback note in A359; rest own state/docs. Before bcb777d9, 11-07: A359 fix1–3 + A367 reviewed in-ask; A362 plan-reviewed. Before 24b7b6b3: 11-06 night: Cursor A341 S151 re-grade + A356 phase 3 reviewed in-ask; rest own/Muse docs. Before: 5a480ee8, 11-06 late: 7e113b14..5a480ee8 — A341/A352/A353/A342–A346 all reviewed in-ask; rest Claude own + Muse docs. Older history in git log of this file)

