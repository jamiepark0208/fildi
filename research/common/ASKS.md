# Agent asks (Claude Code ↔ Cursor ↔ Muse)

**Index only — one line per row.** Full spec, replies, status notes and reviews live in `asks/A##.md` (open a file only when you act on that row).
Format (2026-10-11): `| [A##](asks/A##.md) | date | from → to | title (≤ ~110 chars) | status |`. Never paste details into this table.
New row: copy `asks/_TEMPLATE.md` → `asks/A##.md` (next id = highest here or in `ASKS-archive.md` + 1), then add the index line.
Status: open → planned → accepted → done → verified | declined (reason in the file). Update the status word here and the notes in the file.
Closed rows (verified / declined / finished FYI): move the index line to `ASKS-archive.md`; keep the file.
Review loop: `AGENTS.md` § Review loop — Muse + Claude reviews go in the file's `## Reviews` section.

**Muse** = live remote agent (bus = git `cursor/mac-dev`, adapter `MUSE.md`). Muse files `Muse → Cursor` only; Cursor owns and implements them (user 2026-10-07).
`[quant]` rows get a Claude plan review before build (user 2026-10-11). Everyone: `git pull --ff-only origin cursor/mac-dev` before acting.

| id | date | from → to | title | status |
|---|---|---|---|---|
| [A38](asks/A38.md) | 2026-10-07 | Cursor → Muse | Standing: monitor app runs smoothly | closed (Muse 10-18: obsolete) |
| [A72](asks/A72.md) | 2026-10-12 | Muse → Cursor | Fildi live-server migration — private always-on app (phased, iterative) | parked (Jamie 10-18: no host decision; revisit when Oracle/always-on go) |
| [A95](asks/A95.md) | 2026-10-14 | Muse → Cursor | Analyst revision breadth: sector upgrade/downgrade timeline | parked (Cursor 10-18: EPS+PT+Book UI shipped; S0xx before score path) |
| [A109](asks/A109.md) | 2026-10-15 | Muse → Cursor | Market microstructure toolkit survey (gamma/dealer research) | parked (Claude 10-15: no index chains; tick data costs money) |
| [A141](asks/A141.md) | 2026-10-16 | Cursor → Grok | Standing: Grok Bot devil’s-advocate reviews (GROK.md) | parked — standing (Grok review lane definition, not a task; aging-exempt) |
| [A163](asks/A163.md) | 2026-10-18 | Grok → Cursor | Live-app click audit session (read-only, Mac) | parked (Cursor 10-18: needs Jamie go that day for live click audit) |
| [A165](asks/A165.md) | 2026-10-18 | Cursor → Claude → Cursor | OpenJev train loop — miss→teach→rebuild; Ideas readiness (P27) | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A166](asks/A166.md) | 2026-10-18 | Cursor → Muse / Claude / Grok | Maintain fildi-feature-synthesis.md (gaps, synthesis, keep current) | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A192](asks/A192.md) | 2026-10-19 | Jamie → Claude → Cursor | [quant] Any-structure builder + view ranker (stock ±, every option combo); backtest ranking after A364 | planned (Claude 11-07: Part L live any-structure builder + view ranker now; Part B waits A364) |
| [A205](asks/A205.md) | 2026-10-19 | Jamie → Codex | Integrate Codex into AI Stage, Ideas and claimed development | partial (Codex 10-19: desktop main activity observed in signed-in Stage; helper coverage pending) |
| [A207](asks/A207.md) | 2026-10-19 | Codex → Cursor | Bounded autonomous development and access visibility | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A208](asks/A208.md) | 2026-10-19 | Codex → Claude → Cursor | Material decision changes using existing action tickets | done (Cursor 11-07, uncommitted) |
| [A210](asks/A210.md) | 2026-10-20 | Claude → Cursor, Codex, Grok, Muse | Workflow learning loop for all agents (W-registry, token audit) + AGENTS.md dedupe + commit-review drift | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A219](asks/A219.md) | 2026-10-20 | Muse → Claude → Cursor | [quant] Market-maker tier-list priors: ORB reconciliation (S056), VIX mean-reversion overlay, VWAP-MR timing, sizing rules | done (Cursor 11-07, failed validation, uncommitted) |
| [A225](asks/A225.md) | 2026-10-20 | Muse → Cursor | Test: Superpowers + Claude Mem gated installs (Mac lane weak spots) | parked (Superpowers deferred; Mem declined) |
| [A227](asks/A227.md) | 2026-10-21 | Muse → Grok + Claude | REVIEW: Muse's Oct 20 reel-batch rejections — challenge every one (18 items) | parked (Claude triage 2026-11-07) |
| [A228](asks/A228.md) | 2026-10-21 | Muse → Claude + Cursor | WRDS + LSEG: usage audit, entitled-but-unused inventory, adoption workstreams W1–W8 | split 10-24 → A264 (W8 panel), A265 (W2 CBOE), W4 = A262 S092; W1/W3/W5–W7 parked |
| [A230](asks/A230.md) | 2026-10-21 | Jamie → Claude → Cursor | [quant] Live forecast quality — Kalshi 15m + multi-signal calibration study | parked (Claude triage 2026-11-07) |
| [A233](asks/A233.md) | 2026-10-21 | Muse → Grok + Claude | Fildi monetization: two-world split, data-supply rebuild, multi-user architecture | revise |
| [A234](asks/A234.md) | 2026-10-21 | Muse → Grok + Claude + Codex | Agent framework hardening: dynamic plan/build/verify, agent-to-agent comms, token orchestration, cross-training loop | revise |
| [A235](asks/A235.md) | 2026-10-21 | Muse → Cursor | Permission hardening: close verified gate gaps (Schwab OAuth, research lanes, sdm, sessions) — pre-invite P0 | done (P0+P1+P2; await review) |
| [A237](asks/A237.md) | 2026-10-21 | Muse → Claude → Cursor | [quant] Neocloud contagion: oversold quality peers after a CRWV-led selloff — relative-value + put-premium study | parked (Claude 10-29, A312: put leg closed; revisit when point-in-time Compustat lands) |
| [A244](asks/A244.md) | 2026-10-22 | Jamie → Claude → Cursor | [quant] Long calls/puts: research-merged strategy (direction × timing × price), study, then Model List/Live/Rankings/Track record | parked (Claude 10-29, A312: S133 FAIL; paper board stays; revisit = revisions + 60-day calls beat buy-all after ±25 % call-cost stress, both halves) |
| [A246](asks/A246.md) | 2026-10-24 | Muse → Claude → Cursor | [quant] Closed-loop strategy self-improvement: generate → backtest → promote/demote with validation gates (paper-only) | parked (Claude 11-08: + A340 merged; revisit A380 verified) |
| [A262](asks/A262.md) | 2026-10-24 | Jamie → Claude → Cursor | [quant] Test every free outside signal source vs Fildi (OSAP, JKP, option signals, StarMine extras, Finnhub, own-data flow, qlib, tastytrade, movers, QC/Quantpedia) — S089–S098 | parked (Claude 11-07: cap; revisit A371 done) |
| [A270](asks/A270.md) | 2026-10-25 | Muse → Claude → Cursor | [quant] Reel-batch quant libs: arch (GARCH+SPA), MAPIE (conformal), PySR (symbolic), tested | done (Cursor 11-07, failed validation, uncommitted) |
| [A276](asks/A276.md) | 2026-10-26 | Muse → Cursor | A238 packet-split pilot: unblock oldest quant studies (A188 + A184) before Dec 11 | verified (Claude 11-03: S124 FAIL; S125 FAIL after 2 bug fixes; pilot GO w/ recomputable hand-check) |
| [A277](asks/A277.md) | 2026-10-26 | Jamie → Claude → Cursor | [quant] One recommendation per structure: Model List, Rankings, Live, Structures read one engine (sell puts first) | planned (Claude 10-29, A312: leftover = retire old pickBestStrike on Rankings + Live; covered-call bands closed S101c) |
| [A281](asks/A281.md) | 2026-10-26 | Claude → Muse, Cursor, Grok | Indicator use cases for Fildi — add (Muse), challenge (Grok), cost (Cursor); map in .agents/context/indicators.md | parked (Claude re-review 11-07 after A370) |
| [A308](asks/A308.md) | 2026-10-28 | Claude → Cursor | [quant] Forward ledger earnings_up: skew + StarMine forecasters (S127 follow-up) | revise (Claude 11-03 commit review: see file) |
| [A318](asks/A318.md) | 2026-10-30 | Cursor → Claude → Cursor | [quant] Stock DB gold: cheapest source inside the FactSet band, then timeliness and derives | planned |
| [A320](asks/A320.md) | 2026-11-02 | Muse → Cursor | Chronos-Bolt fair retest: less-smooth targets, adopt/drop gate + catalog row | parked (Claude triage 2026-11-07) |
| [A321](asks/A321.md) | 2026-11-02 | Muse → Cursor | FinBERT real-headline validation: adopt as triage or drop + catalog row | done (Cursor 11-07, drop, uncommitted) |
| [A322](asks/A322.md) | 2026-11-02 | Muse → Cursor | Setup-but-unused credentials verdict: Codiv keep/drop, S&P Global auth+license check | done (Cursor 11-07) |
| [A323](asks/A323.md) | 2026-11-02 | Muse → Cursor | Settings catalog freshness: registry-driven rows + backfill post-Oct-24 tools | done (Cursor 11-07) |
| [A324](asks/A324.md) | 2026-11-02 | Muse → Cursor | CI red: api-server unit tests fail on branch tip (regression window f476 + 1e7c) | done (green since 3c3bc7a9) |
| [A326](asks/A326.md) | 2026-11-03 | Muse → Cursor | CI red: stock-compare typecheck fails since ae575af55 (DisplayRow vs StockDBTab) | done (already matched in tree, Cursor 11-07) |
| [A329](asks/A329.md) | 2026-11-03 | Jamie → Claude → Cursor | Stock DB full audit: every name × field, root cause, SEC-verified, guard per error class | planned (seg3 accepted 11-05) |
| [A327](asks/A327.md) | 2026-11-03 | Jamie → Claude → Cursor | [quant] Learning loop v2: week-clustered, grades rejected ideas, demotes failing rules, replay on history | verified (live check 11-13) |
| [A330](asks/A330.md) | 2026-11-03 | Jamie → Claude → Cursor | [quant] Wire S151 turning-point signals into Model List, put engine, option score, Live, Explain (shadow first) | done (stage 1 11-05; stage 2 unblocked — A327 verified 11-06) |
| [A331](asks/A331.md) | 2026-11-03 | Jamie → Claude → Cursor | Backtest Lab: interactive backtest page (inputs, signal builder, candles + markers, inspector, results vs baseline) | done (Cursor P1 backend 11-04) |
| [A291](asks/A291.md) | 2026-10-28 | Claude → Cursor | [quant] S120: is bad earnings news punished more than good news is rewarded lately? (extends S018) | verified (Claude ran S120: asymmetry always ~3×, not worse in 2026) |
| [A292](asks/A292.md) | 2026-10-28 | Claude → Cursor | [quant] S121: does the DCF expensive flag hurt puts only when rates rise? (S119 follow-up) | verified (Claude ran S121 stock-level: hint only) |
| [A332](asks/A332.md) | 2026-11-03 | Claude → Cursor | Agent token diet: split 4 most-grepped oversized files + prune grep-polluting dirs | declined (merged into A381, Claude 11-07) |
| [A333](asks/A333.md) | 2026-11-04 | Muse → Cursor | OpenBB + Hermes: free-terminal stack evaluation — research-lane data + report pilot | parked (Claude triage 2026-11-07) |
| [A334](asks/A334.md) | 2026-11-04 | Jamie → Claude → Cursor | [quant] S152 option-priced structures (straddle, verticals, outright) on indicator signals vs random | done |
| [A335](asks/A335.md) | 2026-11-04 | Jamie → Claude → Cursor | [quant] S153 reverse-engineer biggest intraday swings → which indicator caught them | done |
| [A336](asks/A336.md) | 2026-11-04 | Jamie → Claude → Cursor | [quant] S154 signal-state playbook: all structures × both sides × before/after × many holds, walk-forward | done |
| [A337](asks/A337.md) | 2026-11-04 | Muse → Cursor | Journal section: babble → structured tasks, agent context + comments, self-recursive learning evolution | planned |
| [A338](asks/A338.md) | 2026-11-04 | Muse → Cursor | Settings › Indicators defaults don't match the charts (Live chart ignores them) | done (Cursor 11-07) |
| [A341](asks/A341.md) | 2026-11-05 | Muse → Claude → Cursor | Quant research starter pack: test engines (NautilusTrader, VectorBT), probe Databento, adopt AFML methods | done (Claude 11-06: verdicts in; S151 → UNPROVEN; Muse radar line open) |
| [A356](asks/A356.md) | 2026-11-06 | Jamie → Claude → Cursor | External tools audit: every outside source/API/tool — usage, limit, UI home, Settings, AI-context wiring, correctness, overlaps | done (Claude 11-06: phases closed; Codiv graded, LSE_KEY -> A357) |
| [A357](asks/A357.md) | 2026-11-06 | Jamie → Claude → Cursor | [quant] Wire London Strategic Edge: real option trades re-price the put-score history | planned |
| [A342](asks/A342.md) | 2026-11-05 | Muse → Cursor | [quant] Learning loop: threshold-only proposals can never promote (no posterior branch) | done |
| [A343](asks/A343.md) | 2026-11-05 | Muse → Cursor | Learning loop: apply_rationale drops the premium redistribution, challenger weights don't sum to 1 | done |
| [A344](asks/A344.md) | 2026-11-05 | Muse → Cursor | Turning points: NaN holdout lift bypasses the 1.5 STOP gate and scores get written anyway | done |
| [A345](asks/A345.md) | 2026-11-05 | Muse → Cursor | Competitors: sector-fill peers enter the ranked cohort, contradicting the taxonomy-group comment | done |
| [A346](asks/A346.md) | 2026-11-05 | Muse → Cursor | Explain cache: technicalHash keys only on the turning-point line's length, so different TP lines collide | done |
| [A347](asks/A347.md) | 2026-11-06 | Muse → Claude → Cursor | Kronos candlestick foundation model: fair validation on fildi data, adopt/drop + catalog row | parked (Claude triage 2026-11-07) |
| [A349](asks/A349.md) | 2026-11-06 | Muse → Claude → Cursor | AI quant lab batch: TradingAgents, AI Hedge Fund, RD-Agent, Freqtrade (OpenBB/Nautilus/Qlib covered) | parked (Claude triage 2026-11-07) |
| [A351](asks/A351.md) | 2026-11-06 | Muse → Claude → Cursor | Evaluate DeepSeek Harness + Super-Agent as the post-Cursor builder seat | parked (Claude triage 2026-11-07) |
| [A352](asks/A352.md) | 2026-11-06 | Claude → Grok | [quant] Put picks fall more than universe; option score ranks backwards — fix grade, test history | verified |
| [A353](asks/A353.md) | 2026-11-06 | Claude → Cursor | [quant] Signals catch swing starts, lose on exits — exit-rule menu + mirror side of S152/S154/S155 | verified |
| [A354](asks/A354.md) | 2026-11-06 | Muse → Cursor | Volume profile chart overlay (POC + value area) + TPO from minute bars; delta out | parked (Claude triage 2026-11-07) |
| [A355](asks/A355.md) | 2026-11-06 | Muse → Cursor | Graphify pilot: query a code graph instead of re-reading files; measured token cut or drop | done (Cursor 11-07, drop, uncommitted) |
| [A358](asks/A358.md) | 2026-11-06 | Muse → Cursor | My List grid lost a column: WATCHLIST_ROW_MINE 6 tracks vs 7 children (279615b) | revise |
| [A359](asks/A359.md) | 2026-11-06 | Claude → Cursor | [quant] Conditional backtests: regime-match entry, exit rules, TP/SL, hits; audit all studies | planned |
| [A360](asks/A360.md) | 2026-11-07 | Muse → Cursor | Evaluate GLM-5.3/5.2 (Zhipu) as post-Cursor builder: API build test vs DeepSeek, cost, verdict | parked (Claude triage 2026-11-07) |
| [A361](asks/A361.md) | 2026-11-07 | Muse → Cursor | Evaluate OpenCode as the post-Cursor harness: provider-agnostic terminal agent, same fixed build task, verdict | parked (Claude triage 2026-11-07) |
| [A362](asks/A362.md) | 2026-11-07 | Muse → Claude → Cursor | [quant] REVIEW: A359 conditional engine correctness — RSI cold start, IV-beta sign, carried fill_bar (High) | done |
| [A363](asks/A363.md) | 2026-11-07 | Muse → Claude → Cursor | [quant] REVIEW: S159 LSE 2003 panel + RSI grid — split-factor direction, confirm indexing, put-exit off-by-one (High) | done (Cursor 11-07, uncommitted) |
| [A364](asks/A364.md) | 2026-11-07 | Muse → Claude → Cursor | [quant] REVIEW: A357 LSE option backfill + regrade — OCC collapse, smoke gate, inverted verdict (High) | done (merged → A357, Claude 11-08) |
| [A365](asks/A365.md) | 2026-11-07 | Muse → Claude → Cursor | [quant] Event-stack guard: warn/block short premium when vol backwardated + print/earnings in expiry | planned |
| [A367](asks/A367.md) | 2026-11-07 | Jamie → Claude → Cursor | Fetch hygiene: backfill once, then fetch only the new tail; guard every heavy fetch/process (watermark, change signal, distinct-only upsert, fetch_runs meter) | done (Cursor 11-07, Claude review 70571445) |
| [A368](asks/A368.md) | 2026-11-07 | Jamie → Claude → Cursor | Strategy board on Track Record › Strategies (Works / Dead / Testing) + Live S159 trigger chip | done (Cursor 11-07, uncommitted) |
| [A369](asks/A369.md) | 2026-11-07 | Jamie → Claude → Cursor | [quant] Faster + higher-quality studies: per-stock threshold lens, cost-aware staging, leak test, precomputed signal tables | verified (fix2b c57d2f80, Claude 11-08) |
| [A370](asks/A370.md) | 2026-11-07 | Jamie → Claude → Cursor | [quant] Indicators as put-timing filters in the seller's universe (high-IV sell / low-IV buy), regime-cut, real quotes | auto-reviewed |
| [A371](asks/A371.md) | 2026-11-07 | Jamie → Claude → Cursor | [quant] Evidence audit of BOARD winners: survivorship, S088 real-quote replay, regime split, one N_eff standard | planned |
| [A372](asks/A372.md) | 2026-11-07 | Jamie → Claude → Cursor | [quant] Put management + book layer: rolling, delta/IV/earnings exits, vol-scaled sizing, book drawdown | planned |
| [A373](asks/A373.md) | 2026-11-07 | Jamie → Claude → Cursor | [quant] Borrow from agentic-trading-desk: macro pillar regime test, 3-pillar backtest, TV-convention indicator tests, invalidation line | planned |
| [A374](asks/A374.md) | 2026-11-07 | Muse → Claude → Cursor | [quant] REVIEW: A359 engine — RSI slice misaligned under session_filter; carried bar-0 lookahead (High) | declined (merged into A359 fix, Claude 11-07) |
| [A375](asks/A375.md) | 2026-11-07 | Muse → Claude → Cursor | [quant] REVIEW: A359 fix4 horizon sweep — confluence on wrong TF; higher-TF RSI dates (High) | declined (merged into A359 fix, Claude 11-07) |
| [A376](asks/A376.md) | 2026-11-07 | Muse → Claude → Cursor | [quant] REVIEW: A369 trade cache never hits (salted hash); stale meta; OPRA cache mismatch (High) | verified (via A369 fix2a/2b, Claude 11-08) |
| [A377](asks/A377.md) | 2026-11-07 | Muse → Claude → Cursor | [quant] REVIEW: A367 fetch hygiene — lab_fund skip gate; frozen submissions signal (High) | done (Cursor 11-07, H1 H2 M1, uncommitted) |
| [A378](asks/A378.md) | 2026-11-07 | Muse → Claude → Cursor | [quant] S160 test-era centering flaw — subtract train-era base for both eras (Medium) | verified (via A369 fix2a + Claude inline, Claude 11-08) |
| [A379](asks/A379.md) | 2026-11-07 | Muse → Claude → Cursor | agent-dispatch Gate 2 dead — smoke-gate refusal never fires (ASK is 0/1, never empty) (Medium) | done (Claude 11-07: gate fixed) |
| [A380](asks/A380.md) | 2026-11-07 | Jamie → Claude → Cursor | [quant] Live vs backtest: every BOARD Works rule graded weekly on real fills; drift flag | planned |
| [A381](asks/A381.md) | 2026-11-07 | Jamie → Claude → Cursor | Repo + instruction diet: archive finished study scripts, split study engines, one rulebook | planned |
| [A383](asks/A383.md) | 2026-11-08 | Jamie → Claude → Cursor | Stock-specific context layer: one nightly table → Breakdown tooltips/colours, option params, agents | planned |
| [A384](asks/A384.md) | 2026-11-08 | Muse → Claude → Cursor | [quant] REVIEW: stock_surface lse_trades WLS weight 1/trades inverts reliability (Medium) | planned |
| [A382](asks/A382.md) | 2026-11-07 | Muse → Claude → Cursor | [quant] REVIEW: structure_vec_engine Part D earnings guard uses run-end date, not expiry (Medium) | declined (merged into A192 Part D fix1; High — S166 biased, re-run, Claude 11-08) |
| [A385](asks/A385.md) | 2026-11-08 | Muse → Cursor | CI red: A340 duplicated in ASKS.md + ASKS-archive.md — delete index copy (High) | done (fixed 11-09 #2: index row removed, archive row kept, Claude) |
| [A386](asks/A386.md) | 2026-11-09 | Muse → Claude → Cursor | Options jobs 40+ min: tail-fetch chains + indexed chain table (Jamie 11-08 #2) | planned (Claude 11-09) |
| [A387](asks/A387.md) | 2026-11-09 | Muse → Claude → Cursor | [quant] Grade the score on trades that pay, not rank IC — dcf/grade.py (Jamie 11-08 #4) | planned (Claude 11-09) |
| [A390](asks/A390.md) | 2026-11-10 | Claude → Claude | [quant] Historical per-name 25Δ skew from LSE OPRA (greeks export, ~3.5 h) → skew as put/call selection feature (Cremers–Weinbaum / Xing–Zhao–Zhang) | planned |
| [A388](asks/A388.md) | 2026-11-10 | Muse → Claude → Cursor | [quant] REVIEW: S178 long-call grid — data-end truncation biases 120/240-DTE exit values down (Medium) | done |
| [A389](asks/A389.md) | 2026-11-10 | Muse → Cursor | S178 call grid crashes at import on a fresh checkout — s178_surface.json not committed (Low) | done |
| [A391](asks/A391.md) | 2026-11-10 | Muse → Cursor | CI red: c2cd4d2 broke the ASKS index — A388/A389 rows deleted, A297/A298 duplicated in index + archive (High) | done |
