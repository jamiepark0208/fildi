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
- **11-07 late-night Claude:** Part C fix3 6c78cb88 PASS. B1 v2 f77dae65 = revise: time21 on ≤21 DTE exits day 1, ranking = mean of ratio (+0.0195 vs pooled +0.0001), stop rule trivial, IV lagged a day → fix1 197b5fcb PASS: A/C STOP (no-lift after tuning, BOARD S164). B2 RUNNING (.agents/dispatch/A192-partB2.md: family B shapes on CSP entries, S165). NEXT: review B2 → family D (debit, expect weak) → E (needs per-expiry IV, underpowered) → A369 fix2. Last reviewed SHA → 197b5fcb.
- **11-07 night Claude:** A192 fix3 done inline (condor BP = max loss, 14/14) → Part L done. Jamie: non-CSP structures look bad because only CSP got tuned (S076 = Monday, hold-to-expiry, no filters). Wrote A192 **Part B0** equal-effort re-test (naive-CSP control, DTE/Δ/wing/exit/entry grid, graded per $ BP, train 21–23 / test 24→). B0 stopped before code (superseded). Jamie gave tastylive guide (~/Downloads/options-strategy-guide.pdf, 31 strategies; © — copy layout only, own text). Plan v4 = PLAN-option-structures.md § 8 (6 families, anchor Stage 1 → variants Stage 2, parity skips, one leg-mark cache). Part C 45a12e7d → fix1 8cdd10bb (shapes pass) → fix2 7e4a142b revise (credit search went ITM) → fix3 dispatched (.agents/dispatch/A192-partC-fix3.md). B1 draft stopped (cache key w/o strike → fake TP); PLAN § 9 = vectorised 3-layer engine (prototype 17.7M vs 1.3M marks/s) + per-family test table; B1 v2 RUNNING (.agents/dispatch/A192-partB1.md) → review gates 1–5 first, then Stage 1 A/C numbers; then Stage 2 / families B, D, E dispatches; then A369 fix2. BOARD "fail" structures = framing? until B0. Then A369 fix2.
- **11-07 eve Claude:** A381 Part B DONE (memory 76→21, rule restatements → contract links, AGENTS verify-path line). Ideas cap 19→15 (A374/A375→A359 fix5, A376/A378→A369 fix2). Review SHA → d5016467. A369 fix1b 31a79507 PASS (top 21n cells placebo_p 0.38–0.61 = no RSI timing edge; fix2 adds NO-TIMING-EDGE verdict + next-session shift for last-bar signals) → A192 Part L 29a95eb9 reviewed = revise (max loss truncated by grid, horizon ignored, POP check) → fix1 6aeccb50 revise (POP wrong T, ranker 0 rows) → fix2 640cd421 + Claude POP fix pushed (POP sane) → NEXT: dispatch A192 fix3 (iron-condor buying power uses full strike range, see A192 review 640cd421), then A369 fix2 → A369 fix2. Reddit API dropped (create gated; Devvit = in-Reddit apps, not data export). Pain points → Jamie pastes threads if he wants; else use vendor-market evidence in monetization notes. scripts/reddit_pains.py kept, unused (`.agents/dispatch/A192-partL.md`, any-structure builder + view ranker, Jamie priority) → A369 fix2 (+288 cached path) → rest of ORDER below. Reddit: `scripts/reddit_pains.py fetch` then `tally` once Jamie adds REDDIT_CLIENT_ID/SECRET to .env.local. Monetization notes in research/common/monetization-2026-11-07.md; waiting on Jamie for Reddit API creds / pasted threads and go on A277 any-structure engine spec. Startup flags left: API catalog missing 2 routes (check-api-endpoints --write), state.md 13k over budget (trim by hand), S020 dead re-screen due (in A371).
- **11-07 Claude (late):** Muse filed A374–A379 meanwhile (id collision with my rows → mine renumbered A380 live-vs-backtest, A381 repo diet). Plan-reviewed: A374+A375 = A359 engine bugs (RSI slice misaligned, carried bar-0 look-ahead, confluence wrong TF, forming higher-TF bar) → **A359 fix5** + re-run 21n grid; BOARD 'short RSI dips' + 'overnight carry' → framing? until fix5. A376 (salted-hash cache, OPRA parity, leak pairing) → A369 fix2. A378 S160 test-era centering → re-run S160 (global RSI<25 Works row + per-stock dead pending). A377 fetch hygiene planned. A379 dispatch Gate 2 fixed (prompts need a 'Smoke gate' section). ORDER: A369 fix1 (RUNNING) → A369 fix2 (+A376, A378) → A359 fix5 (A374+A375) → A370 revise → A371 → A380 → A377 → A381 A.
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

Last reviewed SHA: 197b5fcb (11-07 late-night: 6c78cb88 pass, f77dae65 revise, 197b5fcb pass, in A192. Before: d5016467 (11-07 eve: c9b09224..d5016467 all Cursor quant commits already reviewed in-ask (A369 e8e3c4db, A359 659d96ba, A192 ebb2ab24, A362 4f9e87ae); rest packet-sha or own. Before: c9b09224 (11-07 late: 2fdd403e fix3b pass + deep_otm fallback note in A359; rest own state/docs. Before bcb777d9, 11-07: A359 fix1–3 + A367 reviewed in-ask; A362 plan-reviewed. Before 24b7b6b3: 11-06 night: Cursor A341 S151 re-grade + A356 phase 3 reviewed in-ask; rest own/Muse docs. Before: 5a480ee8, 11-06 late: 7e113b14..5a480ee8 — A341/A352/A353/A342–A346 all reviewed in-ask; rest Claude own + Muse docs. Older history in git log of this file)

