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
| [A67](asks/A67.md) | 2026-10-12 | Muse → Cursor | Run the A51 event-window study before CPI (Oct 14) | deferred (CPI passed; run only if A51 wanted) |
| [A72](asks/A72.md) | 2026-10-12 | Muse → Cursor | Fildi live-server migration — private always-on app (phased, iterative) | parked (Jamie 10-18: no host decision; revisit when Oracle/always-on go) |
| [A79](asks/A79.md) | 2026-10-14 | Muse → Cursor | Earnings risk score on the calendar (pre-earnings blowup flag) | parked (Cursor 10-18: study-first; Claude plan — strike vs own earnings moves) |
| [A95](asks/A95.md) | 2026-10-14 | Muse → Cursor | Analyst revision breadth: sector upgrade/downgrade timeline | parked (Cursor 10-18: EPS+PT+Book UI shipped; S0xx before score path) |
| [A101](asks/A101.md) | 2026-10-14 | Muse → Cursor | Easy-win scanner: laggards, reversals, vol mispricings | parked (Cursor 10-18: laggard phase study-first; 2/4 phases already built) |
| [A103](asks/A103.md) | 2026-10-15 | Muse → Cursor | SkillOpt pilot: validation-gated self-evolving skills for fildi agents | parked (Claude 10-15: no LLM task with labels yet) |
| [A109](asks/A109.md) | 2026-10-15 | Muse → Cursor | Market microstructure toolkit survey (gamma/dealer research) | parked (Claude 10-15: no index chains; tick data costs money) |
| [A115](asks/A115.md) | 2026-10-15 | Muse → Cursor | Trend-efficiency regime filter for premium selling | parked (Cursor 10-18: regime bake-off study with A117/A56 before filter) |
| [A119](asks/A119.md) | 2026-10-15 | Muse → Cursor | Personal AI agent landscape: free-tier use cases (hermes, openclaw, grokbot, dots, instinct) | parked (Claude 10-16: Hermes vs SkillOpt waits on A103's trigger) |
| [A126](asks/A126.md) | 2026-10-16 | Muse → Cursor | Order-flow-style chart indicators (volume profile, VWAP, volume) | parked (Cursor 10-18: 1m+5m shipped; Jamie UI eyeball) |
| [A130](asks/A130.md) | 2026-10-16 | Muse → Cursor | Pilot OmniRoute free-tier gateway | parked (step 1 Haiku log done 10-16; OmniRoute out until metered AI >$20/mo) |
| [A133](asks/A133.md) | 2026-10-16 | Muse → Cursor | Evaluate PentPort data API | parked (Cursor 10-18: blocked Jamie PentPort signup) |
| [A139](asks/A139.md) | 2026-10-16 | Muse → Cursor | ICT indicator suite + rank-weighted composite | parked (Cursor 10-18: overlays shipped; S036 gates composite) |
| [A140](asks/A140.md) | 2026-10-17 | Muse → Grok | Post-down-day setup flag for scanner + options-book brief | needs Jamie |
| [A141](asks/A141.md) | 2026-10-16 | Cursor → Grok | Standing: Grok Bot devil’s-advocate reviews (GROK.md) | parked — standing (Grok review lane definition, not a task; aging-exempt) |
| [A157](asks/A157.md) | 2026-10-18 | Grok → Claude | Grok Bot game plan: phases 0-5 for Claude, Muse, Cursor review | planned (Claude verified phases 10-18) |
| [A163](asks/A163.md) | 2026-10-18 | Grok → Cursor | Live-app click audit session (read-only, Mac) | parked (Cursor 10-18: needs Jamie go that day for live click audit) |
| [A165](asks/A165.md) | 2026-10-18 | Cursor → Claude → Cursor | OpenJev train loop — miss→teach→rebuild; Ideas readiness (P27) | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A166](asks/A166.md) | 2026-10-18 | Cursor → Muse / Claude / Grok | Maintain fildi-feature-synthesis.md (gaps, synthesis, keep current) | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A184](asks/A184.md) | 2026-10-19 | Claude → Claude | [quant] Strategy backlog: ORB, intraday momentum, FVG, revisions drift, trend, 52w high, RSI(2), squeeze, GEX | open |
| [A188](asks/A188.md) | 2026-10-19 | Claude → Claude | [quant] Intraday mispricing list (research-based): option day/night, EOD hedging momentum, 0DTE regime, opex pinning, liquidity reversal, pre-FOMC | open |
| [A192](asks/A192.md) | 2026-10-19 | Claude → Claude | [quant] Rank every major option structure (Structures tab): plan v2 + Phase 0 skew survey | accepted (Phase 0 running) |
| [A195](asks/A195.md) | 2026-10-19 | Muse → Claude → Cursor | [quant] Cointegration divergence as put-selling entry signal — study | auto-reviewed |
| [A205](asks/A205.md) | 2026-10-19 | Jamie → Codex | Integrate Codex into AI Stage, Ideas and claimed development | partial (Codex 10-19: desktop main activity observed in signed-in Stage; helper coverage pending) |
| [A206](asks/A206.md) | 2026-10-19 | Codex → Codex | [quant] Validate financial assessment before extending put-edge claims | partial (Codex 10-20: Focus/calendar fixes tested; financial recalibration pending) |
| [A207](asks/A207.md) | 2026-10-19 | Codex → Cursor | Bounded autonomous development and access visibility | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A208](asks/A208.md) | 2026-10-19 | Codex → Claude | Material decision changes using existing action tickets | planned |
| [A210](asks/A210.md) | 2026-10-20 | Claude → Cursor, Codex, Grok, Muse | Workflow learning loop for all agents (W-registry, token audit) + AGENTS.md dedupe + commit-review drift | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A219](asks/A219.md) | 2026-10-20 | Muse → Claude → Cursor | [quant] Market-maker tier-list priors: ORB reconciliation (S056), VIX mean-reversion overlay, VWAP-MR timing, sizing rules | planned (Claude 10-29, A312 narrowed: VWAP timing + VIX overlay only; ORB declined) |
| [A222](asks/A222.md) | 2026-10-20 | Muse → Claude → Cursor | [quant] Qlib downside-label underlying ranking as a score factor | auto-reviewed |
| [A225](asks/A225.md) | 2026-10-20 | Muse → Cursor | Test: Superpowers + Claude Mem gated installs (Mac lane weak spots) | parked (Superpowers deferred; Mem declined) |
| [A226](asks/A226.md) | 2026-10-21 | Muse → Cursor | Bug: StructureLab imports missing @/components/data-tip — CI Typecheck red since 0843d076 | done (Claude 10-21) |
| [A227](asks/A227.md) | 2026-10-21 | Muse → Grok + Claude | REVIEW: Muse's Oct 20 reel-batch rejections — challenge every one (18 items) | needs Jamie |
| [A228](asks/A228.md) | 2026-10-21 | Muse → Claude + Cursor | WRDS + LSEG: usage audit, entitled-but-unused inventory, adoption workstreams W1–W8 | split 10-24 → A264 (W8 panel), A265 (W2 CBOE), W4 = A262 S092; W1/W3/W5–W7 parked |
| [A229](asks/A229.md) | 2026-10-21 | Claude → all agents | Pipeline schedule changes: 05:00 PT data chain, list ≥ 07:00 PT, retries, OpenJev/transcripts timing | done (FYI) |
| [A230](asks/A230.md) | 2026-10-21 | Jamie → Claude → Cursor | [quant] Live forecast quality — Kalshi 15m + multi-signal calibration study | planned (Claude 10-29, A312 narrowed: Kalshi candles only when history already stored) |
| [A231](asks/A231.md) | 2026-10-21 | Muse → Cursor | CI red on tip — ASKS rows A214/A230 link missing ask files (a219961e) | done (Muse 10-21: files restored from Mac working tree) |
| [A233](asks/A233.md) | 2026-10-21 | Muse → Grok + Claude | Fildi monetization: two-world split, data-supply rebuild, multi-user architecture | revise |
| [A234](asks/A234.md) | 2026-10-21 | Muse → Grok + Claude + Codex | Agent framework hardening: dynamic plan/build/verify, agent-to-agent comms, token orchestration, cross-training loop | revise |
| [A235](asks/A235.md) | 2026-10-21 | Muse → Cursor | Permission hardening: close verified gate gaps (Schwab OAuth, research lanes, sdm, sessions) — pre-invite P0 | done (P0+P1+P2; await review) |
| [A236](asks/A236.md) | 2026-10-21 | Claude → Cursor | Pipeline follow-ups: verify 05:00 run, late-open list-first, precompute 29 min, Finnhub limit, request audit | open (Codex 11-03: needs Claude plan review; precompute failures reported as ran) |
| [A237](asks/A237.md) | 2026-10-21 | Muse → Claude → Cursor | [quant] Neocloud contagion: oversold quality peers after a CRWV-led selloff — relative-value + put-premium study | parked (Claude 10-29, A312: put leg closed; revisit when point-in-time Compustat lands) |
| [A238](asks/A238.md) | 2026-10-21 | Claude → Cursor | Heavy-token queue: Cursor runs reviews-packets/backtests/studies, Claude judges from ≤ 20-line packets | done (Claude 10-29, A312: packet split is standard practice) |
| [A239](asks/A239.md) | 2026-10-21 | Claude → Cursor | Stage tab: draw Claude → Cursor/Grok dispatch beams (cursor-agent wrapper + parent tag) | done (Cursor 10-21) |
| [A240](asks/A240.md) | 2026-10-21 | Claude → Cursor | [quant] Earnings dates missing for ~23 % of put candidates (NEM FCX UPS ETN…) → re-strike skipped | done |
| [A241](asks/A241.md) | 2026-10-21 | Grok → Cursor | GCP free VM shadow: public jobs + public DB copy, Mac untouched until parity pass + Jamie go | parked (Jamie 10-26 STOP; VM TERMINATED; reopen only if Jamie unparks) |
| [A242](asks/A242.md) | 2026-10-22 | Muse → Cursor | CI red on cursor/mac-dev: fix StructuresBoard imports (formatMd, ticker-link) + gitleaks allowlist for MISSING_UPCOMING_EMPTY_KEY | done (Cursor 10-22: gitleaks allowlist; formatMd+ticker-link already on tip) |
| [A243](asks/A243.md) | 2026-10-22 | Claude → Cursor | [quant] Model List stability: keep ideas until they break, daily scores, no cash gate, long call/put sections | done (Cursor 10-22: freshness+universe gate+carry+cash; LSEG RIC expand optional) |
| [A244](asks/A244.md) | 2026-10-22 | Jamie → Claude → Cursor | [quant] Long calls/puts: research-merged strategy (direction × timing × price), study, then Model List/Live/Rankings/Track record | parked (Claude 10-29, A312: S133 FAIL; paper board stays; revisit = revisions + 60-day calls beat buy-all after ±25 % call-cost stress, both halves) |
| [A245](asks/A245.md) | 2026-10-22 | Jamie → Claude → Cursor | [quant] What preceded real lows/highs: swing-extrema study vs look-alike crashes (feeds A244) | done (S082 PASS packet; Claude freeze/product) |
| [A246](asks/A246.md) | 2026-10-24 | Muse → Claude → Cursor | [quant] Closed-loop strategy self-improvement: generate → backtest → promote/demote with validation gates (paper-only) | planned (Claude 10-29, A312 narrowed: phase 1 only, false-winner gate) |
| [A248](asks/A248.md) | 2026-10-24 | Claude → Cursor | RBH export: 60 stale assignment_sell false positives; find root cause + check patch hides no real assignment | done (net-exit gate; 63 empty rows left for Claude) |
| [A249](asks/A249.md) | 2026-10-24 | Claude → Grok | Red-team A248: symbol-level suppression of assignment warnings | done (Grok red-team 10-26: revise — fixes 1–6 for Claude/Cursor on A248) |
| [A250](asks/A250.md) | 2026-10-24 | Claude → Cursor, Muse, Grok | [quant] Model List puts now sold at ~0.09Δ (was 0.15Δ): what changed + why (S088-vs-ML) — FYI + review | done (Cursor 10-28: 0.09 still live)|
| [A251](asks/A251.md) | 2026-10-24 | Claude → Cursor | Mac startup + duplicate-process fixes: Postgres/API at login, API survives DB restart, OpenJev unloads after batch — FYI + ops review | open (Codex 11-03: needs Claude plan review; Live refresh rejection can shut down API) |
| [A252](asks/A252.md) | 2026-10-24 | Muse → Cursor | Rankings live-price fan-out per load (A64 pattern recurs) — default to DB-only | done (Cursor 10-24: default livePrices off; opt-in =1) |
| [A253](asks/A253.md) | 2026-10-24 | Muse → Cursor | Scorer: invalid delta becomes max-safety delta (null→0 conversion) | done |
| [A254](asks/A254.md) | 2026-10-24 | Muse → Cursor | Liquidity gate never enforced in pickBestStrike — hard-exclude or rename | done |
| [A255](asks/A255.md) | 2026-10-24 | Muse → Cursor | TS put-edge factors stale-tolerant, ETF-blind, shadow-only vs Python | done |
| [A256](asks/A256.md) | 2026-10-24 | Muse → Cursor | Relaxed watchlist rows indistinguishable from strict rows — persist relaxed flag | done |
| [A257](asks/A257.md) | 2026-10-24 | Muse → Cursor | Server VaR correlation tail-aligned, not date-joined; shorts treated as longs | done (Claude pass 3857b73b; verified after Muse review) |
| [A258](asks/A258.md) | 2026-10-24 | Muse → Cursor | forecast_ledger.resolve: one bad row aborts the whole run — per-question isolation | done |
| [A259](asks/A259.md) | 2026-10-24 | Muse → Cursor | Frontend P&L absolute-value substitution can flip sign | done |
| [A260](asks/A260.md) | 2026-10-24 | Muse → Cursor | pm_alerts MC front-expiry only — multi-expiry books understate margin risk | done (Jamie 10-29: front label + notional enough; back-expiry amber follow-up closed) |
| [A261](asks/A261.md) | 2026-10-24 | Jamie → Claude → Cursor | OpenJev morning news shortlist: check-first tickers + peers from desk emails + headlines; drops junk emails before Haiku | done (Claude review pass a68271a2; Muse ops review → verified) |
| [A262](asks/A262.md) | 2026-10-24 | Jamie → Claude → Cursor | [quant] Test every free outside signal source vs Fildi (OSAP, JKP, option signals, StarMine extras, Finnhub, own-data flow, qlib, tastytrade, movers, QC/Quantpedia) — S089–S098 | planned (Claude 10-29, A312 narrowed: Polygon endpoints from stored tables, no fresh fetch; tastytrade rank ~2027-03) |
| [A263](asks/A263.md) | 2026-10-24 | Jamie → Claude → Cursor | Data-source inventory: every API/tool set up — unused endpoints + fields, ranked by value | done (Claude review pass 67808fc0; research/common/data-inventory.md) |
| [A264](asks/A264.md) | 2026-10-24 | Muse → Claude → Cursor | Data Sources panel: every source, what it feeds, calls vs limit, unused-but-available (A228 W8) | done |
| [A265](asks/A265.md) | 2026-10-24 | Muse → Claude → Cursor | CBOE index history pull: VIX, VIX9D, VIX3M, VVIX, SKEW (A228 W2) | done |
| [A266](asks/A266.md) | 2026-10-24 | Jamie → Claude → Cursor | Store every vendor response we fetch (vendor_raw) + map the dropped Finnhub/FMP/FactSet fields; display, no score change | done (Claude review pass e283c734; finding 1 dividend hunk pending) |
| [A267](asks/A267.md) | 2026-10-24 | Jamie → Claude → Cursor | Use unused Massive (Form 4, 8-K, related, short interest universe) + Schwab (movers, expirationchain, markets, metering) endpoints | done (Claude review pass 06a33418 + fix-up; Monday universe run → S099) |
| [A268](asks/A268.md) | 2026-10-24 | Jamie → Claude → Cursor | One-command signal test (lab.py signal / s045 signal on cached panels) — seconds per idea | done (Claude review pass 10-24) |
| [A269](asks/A269.md) | 2026-10-24 | Muse → Cursor | CI secret scan red since e0ac416: gitleaks finnhub-access-token false positive on finnhub-client.ts import — allowlist or rename | done |
| [A270](asks/A270.md) | 2026-10-25 | Muse → Claude → Cursor | [quant] Reel-batch quant libs: arch (GARCH+SPA), MAPIE (conformal), PySR (symbolic), tested | planned (Claude 10-29, A312: one GARCH packet on put-pnl harness only; PySR declined; MAPIE wraps that forecast) |
| [A272](asks/A272.md) | 2026-10-25 | Muse → Claude → Cursor | [quant] College quant projects: MP cleaning, Kalman pairs, AS quoting, AC scheduling, tested | planned (Claude 10-29, A312 narrowed: correlation cleaning only; VaR date-join fix done) |
| [A271](asks/A271.md) | 2026-10-25 | Claude → Cursor | [quant] Structures reads the rules engine (strategy_engine.py): inputs on every row, gates, CSP = put ladder, long-call rank — Model List unification inherits it | done (Claude built 10-25; UI fields for Cursor) |
| [A274](asks/A274.md) | 2026-10-26 | Muse → Cursor | Repair: /api/options/rankings ignores livePrices — A252 done claim fails at HEAD | done (Cursor 10-26: default off + rankingsWantLivePrices test) |
| [A275](asks/A275.md) | 2026-10-26 | Muse → Cursor | Surface snapshot age on DB-only option surfaces (Live table first) | done (Cursor 10-26: asOf + STALE >1 trading day) |
| [A276](asks/A276.md) | 2026-10-26 | Muse → Cursor | A238 packet-split pilot: unblock oldest quant studies (A188 + A184) before Dec 11 | verified (Claude 11-03: S124 FAIL; S125 FAIL after 2 bug fixes; pilot GO w/ recomputable hand-check) |
| [A277](asks/A277.md) | 2026-10-26 | Jamie → Claude → Cursor | [quant] One recommendation per structure: Model List, Rankings, Live, Structures read one engine (sell puts first) | planned (Claude 10-29, A312: leftover = retire old pickBestStrike on Rankings + Live; covered-call bands closed S101c) |
| [A278](asks/A278.md) | 2026-10-26 | Muse → Cursor | Repair: Rankings Structures tab broken — StructuresHub + structure-slots missing (abf9614), CI typecheck red | done (Cursor 10-27: verified 0ef05aab Hub+slots; HEAD tsc green; dirty lab WIP left out) |
| [A279](asks/A279.md) | 2026-10-26 | Jamie → Claude | [quant] TradingView indicators (UT Bot, SuperTrend cluster/div, SMC, Fear & Greed): built, S102 on sold puts, display + put-edge relax in sector drop | done |
| [A280](asks/A280.md) | 2026-10-26 | Claude → Cursor | Live › Portfolio alerts: show put_manage_daily (take + re-sell at ≥ 4× pace, hold, no trend stops; S103) | done |
| [A281](asks/A281.md) | 2026-10-26 | Claude → Muse, Cursor, Grok | Indicator use cases for Fildi — add (Muse), challenge (Grok), cost (Cursor); map in .agents/context/indicators.md | parked (Claude 10-29, A312: indicator families now run via A314; revisit after 12-11 token cliff) |
| [A282](asks/A282.md) | 2026-10-26 | Muse → Cursor | Repair: indicators.py recent_div mixes pivot-2 mask with pivot-5 values — ut_conf divergence engine silenced (3931405c) | done |
| [A283](asks/A283.md) | 2026-10-27 | Jamie → Claude | [quant] Fair value v2 — analyst-style probabilistic DCF (sector defaults, stock overrides, scenarios) | done (fv-2.0.0 chips shipped 11-02) |
| [A284](asks/A284.md) | 2026-10-27 | Claude → Cursor | Breakdown — show outside intrinsic values (StarMine, FMP DCF) next to Fildi fair value | done (Cursor 10-28: Outside estimates in FairValueBadge on open) |
| [A285](asks/A285.md) | 2026-10-27 | Muse → Cursor | Repair: fundamentals-db TDZ crash — reviewedRows/reviewed used before declaration, score recompute throws | done (Cursor 10-27: hoist kept + attachPeerReviewed test + dry-run ok) |
| [A289](asks/A289.md) | 2026-10-27 | Claude → Cursor | Breakdown › Assumptions — DCF v2 (lab) block: range vs price, reverse DCF, assumptions with sources | done (Cursor 10-28: DCF lab block on Assumptions tab) |
| [A290](asks/A290.md) | 2026-10-28 | Claude → Cursor | Put-band selector in the app (auto · closer/farther · fixed) — UI for /strategies/put-band | done |
| [A293](asks/A293.md) | 2026-10-28 | Claude → Cursor | AI money-flow tracker: consensus revenue revisions by supply-chain bucket (fiscal-period matched) | done |
| [A286](asks/A286.md) | 2026-10-27 | Claude → Cursor | [quant] DCF segment sum-of-the-parts from full XBRL (per-segment growth/margin) | done (Cursor 10-28: XBRL segment parse+table; SOTP NOPAT path still open) |
| [A288](asks/A288.md) | 2026-10-27 | Claude → Cursor | [quant] DCF bridge — in-the-money convertibles as shares, not debt | done (Claude pass 99fc6eea 11-03: BABA ADS shares + dilution fixed; awaits Muse) |
| [A294](asks/A294.md) | 2026-10-28 | Muse → Cursor | Repair: model-list-panel uses VERDICT_CHIPS + fields the model-list hook never exports — CI typecheck red | done (Cursor 10-28: VERDICT_CHIPS + universe + section-confidence + learn stamps shipped) |
| [A295](asks/A295.md) | 2026-10-28 | Claude → Cursor | [quant] S123: earnings-cycle + geopolitics states — do they spot bull/bear phases and change which structure / put band wins? | revise (Claude 11-03 commit review: see file) |
| [A296](asks/A296.md) | 2026-10-28 | Claude → Cursor | Monthly theme sweep: what research houses are watching (source × theme table → Key Themes) | done (Cursor 10-28: theme_sweeps/2026-10.md) |
| [A297](asks/A297.md) | 2026-10-28 | Claude → Cursor | [quant] S124: after a big SPY intraday drop, do far-OTM 0DTE calls held uncapped pay for the days they expire worthless? | revise (Claude 11-03 commit review: see file) |
| [A298](asks/A298.md) | 2026-10-28 | Claude → Cursor | [quant] S125: long SPY/QQQ calls when the panic breaks (VIX ÷ VIX3M back < 1) vs selling puts / stock | revise (Claude 11-03 commit review: see file) |
| [A299](asks/A299.md) | 2026-10-28 | Claude → Cursor | [quant] S126: long calls on crashed themes whose revenue forecasts still rise | done (Cursor 10-28: S132 FAIL)|
| [A300](asks/A300.md) | 2026-10-28 | Muse → Cursor | Repair: macro-themes imports readChartsCacheFile/readMacroCacheFile that macro-cache never exports — Key Themes + explain broken | done (fixed 02aa8c44; Claude checked 10-28) |
| [A301](asks/A301.md) | 2026-10-28 | Cursor → Claude | Daily News Desk adds quality: Muse-compress + dig email URLs + theme/watch weight (A45 follow-on) | done (Cursor 10-28: Muse levels + theme rank + crawl dig) |
| [A302](asks/A302.md) | 2026-10-28 | Claude → Cursor | Commit (or drop) the Live-tab WIP running uncommitted since 10-21 — Asia deadline + DNS bypass | done |
| [A303](asks/A303.md) | 2026-10-28 | Claude → Claude | One vendor policy table + cross-process budgets + macro merge-with-prior (runtime audit) | done (Claude 10-28: built + tested) |
| [A304](asks/A304.md) | 2026-10-28 | Muse → Cursor | CI typecheck red — stock-breakdown + options-scanner import missing sub-tabs + HeaderStats | done (Cursor 10-28: sub-tabs + HeaderStats + Kalshi/macro exports) |
| [A305](asks/A305.md) | 2026-10-28 | Muse → Cursor | One tab system + one type system: Live-tab pattern everywhere, font/color refactor with drift guards | done (Phase 0–2; guard hard on gray) |
| [A306](asks/A306.md) | 2026-10-28 | Claude → Cursor | RBH daily export is noisy, not clean: order history only page 1, hand-edited payloads, LLM doing fetch work — help simplify | done (Cursor 10-28: paging/dedup/reorder)|
| [A307](asks/A307.md) | 2026-10-28 | Claude → Cursor | [quant] Grade Live hotlist entry verdicts — still gated on the failed market-direction call (S126) | done |
| [A308](asks/A308.md) | 2026-10-28 | Claude → Cursor | [quant] Forward ledger earnings_up: skew + StarMine forecasters (S127 follow-up) | revise (Claude 11-03 commit review: see file) |
| [A309](asks/A309.md) | 2026-10-28 | Claude → Cursor | [quant] Regime flags per stock (ER, ATR pct, KAMA, jump model) vs own-IV put breach — cross-section power | done |
| [A310](asks/A310.md) | 2026-10-28 | Claude → Cursor | [quant] Head-to-head: Alpaca wheel strike score vs Fildi put engine on S088 candidates | done |
| [A311](asks/A311.md) | 2026-10-28 | Claude → Cursor | Log SPY/QQQ dealer gamma (GEX) daily from Schwab chains | done |
| [A312](asks/A312.md) | 2026-10-28 | Cursor → Claude | Triage open Cursor queue — park / decline / keep (Jamie 10-28) | done (Claude 10-29: Grok plan applied; Cursor queue = A219 A230 A246 A262 A270 A272 A277 + A314) |
| [A314](asks/A314.md) | 2026-10-28 | Claude → Cursor | [quant] Regime program — sweep credible regime/reversal methods (event-driven) | accepted |
| [A315](asks/A315.md) | 2026-10-29 | Claude → Cursor | Breakdown — visible "Outside values" box: every fair value source by family (street · cash-flow · floor) + Trading Central levels/outlook | done |
| [A316](asks/A316.md) | 2026-10-29 | Claude → Cursor | Put list — show "moves with" group + news-gap tag per put idea + AI explain lines | done |
| [A317](asks/A317.md) | 2026-10-30 | Muse → Cursor | writeEarningsHistory deletes all upcoming dates when vendor returns two within 21 days | done |
| [A318](asks/A318.md) | 2026-10-30 | Cursor → Claude | [quant] Stock DB gold: cheapest source inside the FactSet band, then timeliness and derives | auto-reviewed |
| [A319](asks/A319.md) | 2026-11-01 | Muse → Cursor | LSE free data as fildi research lane (never live) — validation study | planned |
| [A320](asks/A320.md) | 2026-11-02 | Muse → Cursor | Chronos-Bolt fair retest: less-smooth targets, adopt/drop gate + catalog row | planned |
| [A321](asks/A321.md) | 2026-11-02 | Muse → Cursor | FinBERT real-headline validation: adopt as triage or drop + catalog row | planned |
| [A322](asks/A322.md) | 2026-11-02 | Muse → Cursor | Setup-but-unused credentials verdict: Codiv keep/drop, S&P Global auth+license check | planned |
| [A323](asks/A323.md) | 2026-11-02 | Muse → Cursor | Settings catalog freshness: registry-driven rows + backfill post-Oct-24 tools | planned |
| [A324](asks/A324.md) | 2026-11-02 | Muse → Cursor | CI red: api-server unit tests fail on branch tip (regression window f476 + 1e7c) | done (green since 3c3bc7a9) |
| [A326](asks/A326.md) | 2026-11-03 | Muse → Cursor | CI red: stock-compare typecheck fails since ae575af55 (DisplayRow vs StockDBTab) | planned |
| [A329](asks/A329.md) | 2026-11-03 | Jamie → Claude → Cursor | Stock DB full audit: every name × field, root cause, SEC-verified, guard per error class | planned (seg3 accepted 11-05) |
| [A327](asks/A327.md) | 2026-11-03 | Jamie → Claude → Cursor | [quant] Learning loop v2: week-clustered, grades rejected ideas, demotes failing rules, replay on history | revise (stage 2 promotion path) |
| [A328](asks/A328.md) | 2026-11-03 | Jamie → Claude → Cursor | [quant] S151: turning points by horizon → indicator combos → trade, entry timing, exit (strict for longs) | planned |
| [A330](asks/A330.md) | 2026-11-03 | Jamie → Claude → Cursor | [quant] Wire S151 turning-point signals into Model List, put engine, option score, Live, Explain (shadow first) | done (stage 1 11-05; stage 2 waits A327) |
| [A331](asks/A331.md) | 2026-11-03 | Jamie → Claude → Cursor | Backtest Lab: interactive backtest page (inputs, signal builder, candles + markers, inspector, results vs baseline) | done (Cursor P1 backend 11-04) |
| [A291](asks/A291.md) | 2026-10-28 | Claude → Cursor | [quant] S120: is bad earnings news punished more than good news is rewarded lately? (extends S018) | verified (Claude ran S120: asymmetry always ~3×, not worse in 2026) |
| [A292](asks/A292.md) | 2026-10-28 | Claude → Cursor | [quant] S121: does the DCF expensive flag hurt puts only when rates rise? (S119 follow-up) | verified (Claude ran S121 stock-level: hint only) |
| [A332](asks/A332.md) | 2026-11-03 | Claude → Cursor | Agent token diet: split 4 most-grepped oversized files + prune grep-polluting dirs | accepted (Claude-filed; target 1 dispatched 11-03) |
| [A333](asks/A333.md) | 2026-11-04 | Muse → Cursor | OpenBB + Hermes: free-terminal stack evaluation — research-lane data + report pilot | planned |
| [A334](asks/A334.md) | 2026-11-04 | Jamie → Claude → Cursor | [quant] S152 option-priced structures (straddle, verticals, outright) on indicator signals vs random | done |
| [A335](asks/A335.md) | 2026-11-04 | Jamie → Claude → Cursor | [quant] S153 reverse-engineer biggest intraday swings → which indicator caught them | done |
| [A336](asks/A336.md) | 2026-11-04 | Jamie → Claude → Cursor | [quant] S154 signal-state playbook: all structures × both sides × before/after × many holds, walk-forward | done |
| [A337](asks/A337.md) | 2026-11-04 | Muse → Cursor | Journal section: babble → structured tasks, agent context + comments, self-recursive learning evolution | planned |
| [A338](asks/A338.md) | 2026-11-04 | Muse → Cursor | Settings › Indicators defaults don't match the charts (Live chart ignores them) | planned |
| [A339](asks/A339.md) | 2026-11-05 | Muse → Claude → Cursor | [quant] Triple-RSI(5) pullback study: reproduce, RSI(2) head-to-head, sell-put timing test | planned |
| [A340](asks/A340.md) | 2026-11-05 | Muse → Claude → Cursor | Genetic strategy search + correlation-diversified portfolio combiner (AlgoFactory method, research lane) | planned |
| [A341](asks/A341.md) | 2026-11-05 | Muse → Claude → Cursor | Quant research starter pack: test engines (NautilusTrader, VectorBT), probe Databento, adopt AFML methods | planned |
