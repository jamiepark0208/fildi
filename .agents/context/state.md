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
- **11-04 phase 1 shipped ebf7ab1e** (Claude review: pass w/ findings): 8 ids in both menus, 411/411 tests, no-look-ahead all ids, Ichimoku shift 25 = TV built-in. Findings: (1) LSH = 1 signal / 1 month SPY 5m — suspected port bug, audit first; (2) commit carried another agent's uncommitted price-chart.tsx Indicators/RSI/MACD work (compiles; owner should know); (3) pivot tie rule unconfirmed. Not browser-checked yet. Phase 2 agent dispatched 11-04 (step 0 = LSH audit).
- **11-04 TV indicator port (Claude → 1 sonnet agent, done):** spec `research/common/tv-indicators-port-spec-2026-11-04.md`, Pine sources `research/sources/tradingview/`. Ports MSO BigBeluga, LSH AlgoAlpha, Squeeze LazyBear, Ichimoku + UT/ST into both chart Indicators menus, 5m/15m/1h resample. Next: review its commit (no-look-ahead tests, Pine fidelity), check Ichimoku vs TradingView embed legend on SPY. Then dispatch phase 2 (same spec file: `lib/indicators` plug-in package, nightly indicator_events/grades/scorecard with fixed verdict rule, Settings › Indicators tab) as ONE sonnet agent.
- **11-04 Live chart TV (Claude):** shipped plain drop-risk labels, UT Bot/SuperTrend + 0-100 odds strip + per-signal hover (walk-forward 1M SPY/QQQ hit 48/54 % = no edge), TradingView embed view (built-ins exact; community scripts can't load). Open, waiting on Jamie: (a) TV alerts→webhook for exact community-script signals (paid plan + 2FA + public tunnel), (b) Pine audit/port of each guide script (Cursor spec), (c) Breakdown Indicators menu on the Fildi Live chart.
- **11-04 PM Claude:** (a) daily.py crashed at put recs (A332 t4 split dropped `_settle_offset` re-export) → fixed + pushed; rest of today's pipeline re-run by hand (put manage → plan L1 → daily --from verify). (b) A329 open bug (1) FIXED: non-USD policy only dropped fields from the run's update, never nulled the DB → now writes null; full merge before/after = only the 22 non-USD filers changed (TM/JD TBVPS + revenue etc. null). STILL OPEN: BABA/TSM have no Yahoo `financialData` in vendor_raw → no currency → finnhub local-currency TBVPS/EPS kept (TSM EPS 98 vs PE 24 at $432). Latest Yahoo rows for TM/JD also lack financialData since 11-01 — check the Yahoo fetcher's modules (producer fix); SEC fact units give CNY for BABA but TSM has no SEC facts. Fallback idea: price-consistency (price/EPS vs vendor PE > 3×) flags local-currency per-share. Bugs (2) SLB P/TBV stale and (3) BAC TBVPS untagged preferred still open. Untracked `merge-trusted-seg3.test.ts` imports the removed shares picker (tsc error; owner = seg3 dispatch).
- **11-04 midday Claude (A329 seg3, done by Claude, not Cursor):** sec_gold_fields.py now writes sharesOutstanding (cover, class-summed, ≤120 d, no ADR, no future dates) + TBVPS (common eq − preferred − goodwill − intangibles, one date; missing leg → none). merge-trusted: SEC wins outright for those 2 (SEC_OWNED_TFCOLS); TBVPS vendors = fallback. Non-USD EPS: yahoo kept (already USD/ADS: price/EPS = PE on 22 names), only fallback vendors cleared. Cursor's shares picker + merge TBVPS derive removed. L2 TBVPS truth calls the same tangible_book. Tests: L2 py ok, 24 TS pass. Before/after CSVs in scratchpad (lost on /clear). Verified live: BAC sh 6.90 B, TMUS 1.059 B (sec), PG/AAL TBVPS negative + P/TBV null, EPS 0 lost; sec wins shares on 360 names. OPEN BUGS: (1) TM/JD/BABA vendor TBVPS still local currency (TM 2956) though NON_USD_PER_SHARE_FIELDS now lists TBVPS — policy not reaching DB, trace applyStatementGoldPolicies order vs TBVPS; (2) SLB P/TBV 2.71 stale vs TBVPS 2.62 (priceToTbv not re-derived); (3) BAC TBVPS = finnhub 41.8 (SEC skipped: preferred untagged). TODO next: re-run seg3 audit L2 + packet; fund/P-E before/after; check sec_gold_fields in the nightly chain runs the whole universe (scored-book = 377 only).
- **NEXT: streamline scheduled jobs (Jamie 11-04 "jobs taking really long"):** launchd = maintain (every 30 min + 05:00, chain once/day), pm-alerts 15 min, openjev 15 min, perf-watch 30 min, schwab-auth-watch 5 min, postgres check 5 min, stack-ensure 12:00/14:45, transcripts 08:00, media-sentiment 08:30, ops-digest weekly, rbh export prompt hourly 13:15–21:15 + export 15:00. Measure step times in the maintain chain log first (which step dominates), then cut: merge the 5-min watchers into one, skip chain steps whose inputs didn't change, run SEC fields only for names with a new filing.
- **11-04 08:35 Claude:** nightly maintain job crashed since A332 t1 split (missing imports) → fixed + ship-check mjs lint; job re-kicked, verify Model List built today.
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

