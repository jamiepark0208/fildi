@AGENTS.md

# TradeDash — Claude Code config
> Claude only. Shared rules: `AGENTS.md`. Topic map: `.agents/context/INDEX.md` (don't load every context file). Session state: `.agents/context/state.md`.

## Style
Caveman (AGENTS.md rule 9). Don't echo code or commands you just ran. 1–2 plain sentences per action. No code blocks or verbatim paths/flags unless asked.

## Startup (once per session)
`python3 scripts/agent_start.py` runs every startup step and prints a digest (full log → `~/.fildi/logs/`; read it only for a failed step). Also `bash scripts/agent-learn.sh claude` (A209) — note top waste turns. Act on the digest:
0. **Product first (Jamie 11-10):** read `.agents/context/product-north-star.md`; each session ships ≥ 1 gap-table row end to end (or names the blocker). Studies only when a row needs one.
1. Sync: `scripts/agent-git-sync.sh` only (AGENTS.md rule 2).
2. Agents › Ideas dismissals (`watchlist_sync.agent_idea_dismissals`) → mark ASKS rows `declined (Jamie dismissed <date>)`, commit.
3. Triage `research/inbox.md`: numbered items, dedupe vs ASKS/INDEX, P1–P3, file rows, clear the inbox.
4. Open ASKS rows **to Claude**, plus statuses `needs Claude` / `sign-off still open`.
5. Review loop (AGENTS.md § Review loop): (a) plan-review **every** open Muse row (`[quant]` also gets the eval) → `**Claude plan <date>:**` in `asks/A##.md` § Reviews, status `planned`; (b) `git log <Last reviewed SHA in state.md>..HEAD` → review quant diffs (`Refs: A##`) **before** reading Muse's review → `**Claude review <sha>:**`, update the SHA.
6. **Scoreboard first (Jamie 11-10):** digest 5d = Jamie's puts vs engine vs Model List. Engine trails Jamie, a producer gap, or ungraded recs → fix that before any new study. Full: `scripts/rec_scoreboard.py`.
**Study preflight (11-10):** inline studies follow `.agents/dispatch/_study-contract.md` (esp. 12 regime · 13 entry candle · 14 probabilistic + literature). Before running, write the regime def + expected sign per regime cell and count trades per cell. Under 30 → don't run or report it; say "can't answer at this n" and what n would take.
**Report rule (11-10):** first line of any result = "Goal moved: yes/no" + the number (scoreboard or bp/$). Nothing found → say so first; never call a by-product a finding.
**Never implement Muse rows** (Cursor owns them). Build/restart on the Mac: `.claude/skills/local-mac-dev.md`.

## Skills (load one at a time, when the task matches a row)
| Need | Skill |
|---|---|
| Build + restart (Mac) | .claude/skills/local-mac-dev.md |
| Data fetch strategy / tiers / TTL decisions | .claude/skills/data-architecture.md |
| Any Yahoo Finance / TTLCache work | .claude/skills/caching-patterns.md |
| New API route or middleware | .claude/skills/api-design-patterns.md |
| Options chain fetch | .claude/skills/options-pricer.md |
| Any option study / structure rec | .agents/skills/fildi-quant-research/options.md |
| RSI/MFI scanner tiers (not Model List) | .claude/skills/signal-filters.md |
| Model List / fit / watchlist_sync scoring | .claude/skills/model-list.md |
| Fildi app UI tables/chrome (GRID_*) | .claude/skills/ui-components.md |
| UI chrome trim (Scorecard presets/blurbs/FAB) | .claude/skills/ui-chrome.md |
| DB schema and queries | .claude/skills/db-patterns.md |
| Trader strategy (mental model) | .claude/skills/trader-context.md |
| Technical scorecard | .claude/skills/technical-scorecard.md |
| TradingView indicators (built, tested, use cases) | .agents/context/indicators.md |
| Feature planning | .claude/skills/feature-planner.md |
| Implementation planning | .claude/skills/writing-plans.md |
| Before dispatching a plan Claude wrote | .claude/skills/plan-passes.md |
| Debugging any bug/failure | .claude/skills/systematic-debugging.md |
| End of session (user-triggered only) | .claude/skills/session-wrap.md |
| Reading images, PDFs, large JSON, assets | .claude/skills/file-reading-strategy.md |
| Market-data fetch scaffolding (data-agent) | .claude/skills/data-agent.md |
| Stock DB Needs Review / cheapest gold overrides | .claude/skills/database-agent.md |
| Data pipeline audit / enrichment health | .claude/skills/data-ops-auditor.md |
| Dev tool reference (codegraph/markitdown/madge) | .claude/skills/startup.md |
| OpenJev miss→teach→eval | .claude/skills/openjev-train.md |
| Grep patterns for hot files | .claude/skills/hot-files.md |
| Backtest / "does X help trades?" | research/studies/PLAYBOOK.md (§ 0 fast screen first) |
| Study judgment (comparators, verdict wording, review packet) | .agents/skills/fildi-quant-research/SKILL.md |
| Indicator / pattern study | .agents/skills/fildi-pattern-research/SKILL.md |
| Data source choice (LSEG/WRDS/Schwab/Polygon/FRED) + budgets | .agents/skills/fildi-market-data/SKILL.md |
| Is a score / rec working? | .agents/skills/fildi-grade-quality/SKILL.md |
| Market / sector thesis, earnings-season read, "is my view right?" | .agents/skills/fildi-market-thesis/SKILL.md |
| Reviewing a study | research/studies/REVIEW.md |
| "Why is X (not) on the Model List" / rebuild | `scripts/watchlist_sync/funnel.py [--ticker T]` · `rebuild.sh` |
| Agent workflow changes | `.agents/context/workflow-learning.md` + `scripts/workflow_audit.py` |

Subagents: verifier (tsc + tests) · data-agent (fetch/cache) · ui-agent (React). Catalog: `.agents/AGENTS.md`.

## Reading code
1. codegraph first (explore / node / search / impact) before any edit. Route map: `node scripts/route-map.mjs`; commit impact: `scripts/commit-impact.sh <sha>`.
2. Else `grep -n`, then Read with offset+limit. Never whole files; cap output (`| head`).
2b. **Output caps (11-03 audit, `scripts/session_bloat.py`: sed+grep = 52 % of context growth, ~250 turns/session):** sed ranges ≤ 80 lines; grep always `-m`/`| head -20`, never `-r` over research/ or .agents/sessions; a known symbol → `codegraph_node` (`includeCode:false` to locate, `codegraph_node` with `includeCode:true` only for the one body); `codegraph_explore` averages 24k chars — use it only for a flow question. Batch independent probes into one call. Before any SQL: `scripts/dbcols.sh <table> [col]` (schema + columns in one line; ~4 guessed columns/session before).
3. Never read: `node_modules/**`, `dist/**`, lockfiles, `generated/api.ts`. (Tracked `*.mjs` like `scripts/maintain.mjs` are source.)
4. OpenJev savers: > 3 candidate files → `scripts/oj.py files --task "…"`; long output → `oj.py run -- <cmd>`; before analysis → `oj.py studies "<q>"`; before filing ASKS → `oj.py dupes "<idea>"`.

## Token budget
- Cost = session length (the whole context is re-sent every turn). One task per session → update state.md → Jamie runs /clear. Prefer `/compact <keep>` at a task boundary; auto-compact fires at 50 %.
- Write decisions and next steps into state.md when they happen, lessons into memory. Not chat.
- Batch independent calls. Edit with Edit, not whole-file rewrites.
- ASKS.md is a one-line index: open `asks/A##.md` only for rows you act on; closed rows → ASKS-archive.md.
- **Subagents:** never `fork`; default inline. Big build (> ~30 min) → ONE fresh agent, `model: sonnet`, short prompt (spec path + acceptance), never parallel.
- **Heavy work → Cursor:** backtests, studies, fetches, review evidence go via ASKS with a pass/fail bar + ≤ 20-line packet; Claude writes specs, judges packets, spot-checks one number. Dispatch: `scripts/agent-dispatch.sh <cursor|grok> <model> <prompt-file> [--ask]` (`--ask` = read-only run). Cursor API models (GPT/Claude/Gemini) out of quota until 11-11 → `composer-2.5`/`auto`; Grok = `grok-4.7-high`. Prompt names exact paths/functions (Cursor runs averaged 40 search calls re-finding them). Studies 2–3 in parallel; code edits one at a time.
- **Watch dispatches without monitors:** run the dispatch itself as the one background task; its exit is the alert (it self-kills when silent 20 min, looping, or > 120 min → exit 124). No extra Monitor/waiter. `scripts/dispatch-status.sh` = one-line view. Never two jobs on one rate-limited vendor (Polygon, LSEG, WRDS).
- **External dep down** (LSEG proxy :9000/:9001, Schwab auth, a login) → probe once, write `blocked: <dep> → run <cmd>` in state.md, tell Jamie in one line, move on. No poll loops.

## Compact instructions
Keep verbatim: every user message, decisions/approvals (and what was NOT approved), exact paths, symbol names, param versions (e.g. fund-1.1.1), unresolved errors, test baselines, uncommitted files and their owners. Drop: tool output already acted on, file contents, superseded plans.

## Key facts
- All caches use `lib/ttl-cache.ts` (TTL table + registry: caching-patterns skill). Field priority: `scripts/merge-trusted.ts` FIELD_DEFS. API catalog: `.agents/context/api-endpoints.md`.
- Universe = `source_fundamentals` distinct tickers (~940; `loadTickerUniverse()` in desk-facts.ts unions it). `fmp_fundamentals` is the FMP subset (~270) — never a denominator (A356). Never hardcode a ticker count.
- Hooks live in `.claude/settings.local.json` only: Read guard (codegraph-precheck), shield snap/check on Bash+Write, agent-event on every tool + prompt, context-nudge on prompt (> 150k ctx → close task). `.claude/hooks/` json files are not read.
