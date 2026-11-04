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
- **11-04 08:30 Claude:** A329 seg 3 (per-share) spec + passes in A329.md; Cursor dispatch running (composer-2.5) → judge packet vs spec (a)–(e), then A330 stage 1–2. A332 t3 still held (AgentsTab WIP uncommitted).
- **NEXT SESSION START HERE (11-04 early, Claude):** Running: Cursor A331 Backtest Lab P1 (backend) — check `scripts/dispatch-status.sh`, then judge its packet in A331.md vs acceptance (preset reproduces S151 breach 0.9 % vs 11.1 % n 113; AAPL 2023-01-04 inspector; 50×5y < 30 s cold / < 3 s cached). Then in order (code edits one at a time, run plan-passes skill on each plan first): A331 P2 UI (answer-first + firing today) → A329 segment 3 (per-share + share counts; truth builder same-period rule) → A330 stage 1–2 (two S151 put challengers) → A327 learning loop v2. Done today: S151 verdict (2 sell-put timing signals pass both regimes; no long-option signal), A329 segs 1+2 accepted (85 % / 77 %, residuals → Needs Review), negative-equity scoring fix, grader fix, plan-passes skill + escape log (.agents/context/plan-passes-log.md). Jamie style: concise, short commands.
- **Code queue after A329 r6 (one at a time):** A331 Backtest Lab P1 → A330 stage 1–2 → A327 learning loop v2 → A332 token diet (file splits, ops). Token audit 11-03 done pt 1+2 (memory project_agent-token-audit); re-measure session_bloat + dispatch tokens after ~5 sessions. A331 P1+P2 pass (78f1ee6b). A332 target 1 pass (e9ece20a); target 2 pass on redo 23b0dd09 (first try reverted: @ts-nocheck hid a load crash); target 4 pass (af5d72fe); target 3 (AgentsTab) held until the owner of its uncommitted edits commits. ship-check now typechecks a clean checkout of the pushed commit + blocks new @ts-nocheck. tsc now 0 (fund-score-explain.ts untracked WIP). Then A329 seg 3. perf-watch slow_route /api/scoring-config (p95 2.2 s, 1/11 calls) = cold pool after agent-build restarts, not a route bug — no change. optlab.iv30 freeze fixed (ivrank re-centre legs). Token audit: re-measure after ~5 sessions. S151 verdict done (2 sell-put signals pass).



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

Last reviewed SHA: 2982fae0 (11-04: 040ad203..2982fae0 — quant commits A332 t2/t4, A276 already reviewed; rest muse docs/briefs)

