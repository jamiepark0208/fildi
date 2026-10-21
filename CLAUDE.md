@AGENTS.md

# TradeDash — Claude Code config
> Claude only. Shared rules: `AGENTS.md`. Topic map: `.agents/context/INDEX.md` (don't load every context file). Session state: `.agents/context/state.md`.

## Style
Caveman (AGENTS.md rule 9). Don't echo code or commands you just ran. 1–2 plain sentences per action. No code blocks or verbatim paths/flags unless asked.

## Startup (once per session)
`python3 scripts/agent_start.py` runs every startup step and prints a digest (full log → `~/.fildi/logs/`; read it only for a failed step). Act on the digest:
1. Sync: `scripts/agent-git-sync.sh` only (AGENTS.md rule 2).
2. Agents › Ideas dismissals (`watchlist_sync.agent_idea_dismissals`) → mark ASKS rows `declined (Jamie dismissed <date>)`, commit.
3. Triage `research/inbox.md`: numbered items, dedupe vs ASKS/INDEX, P1–P3, file rows, clear the inbox.
4. Open ASKS rows **to Claude**, plus statuses `needs Claude` / `sign-off still open`.
5. Review loop (AGENTS.md § Review loop): (a) plan-review **every** open Muse row (`[quant]` also gets the eval) → `**Claude plan <date>:**` in `asks/A##.md` § Reviews, status `planned`; (b) `git log <Last reviewed SHA in state.md>..HEAD` → review quant diffs (`Refs: A##`) **before** reading Muse's review → `**Claude review <sha>:**`, update the SHA.
**Never implement Muse rows** (Cursor owns them). Build/restart on the Mac: `.claude/skills/local-mac-dev.md`.

## Skills (load one at a time, when the task matches a row)
| Need | Skill |
|---|---|
| Build + restart (Mac) | .claude/skills/local-mac-dev.md |
| Build + restart (Replit only) | .claude/skills/build-and-run.md |
| Data fetch strategy / tiers / TTL decisions | .claude/skills/data-architecture.md |
| Any Yahoo Finance / TTLCache work | .claude/skills/caching-patterns.md |
| New API route or middleware | .claude/skills/api-design-patterns.md |
| Options chain fetch | .claude/skills/options-pricer.md |
| RSI/MFI scanner tiers (not Model List) | .claude/skills/signal-filters.md |
| Model List / fit / watchlist_sync scoring | .claude/skills/model-list.md |
| Fildi app UI tables/chrome (GRID_*) | .claude/skills/ui-components.md |
| DB schema and queries | .claude/skills/db-patterns.md |
| Trader strategy (mental model) | .claude/skills/trader-context.md |
| Technical scorecard | .claude/skills/technical-scorecard.md |
| Feature planning | .claude/skills/feature-planner.md |
| Implementation planning | .claude/skills/writing-plans.md |
| Debugging any bug/failure | .claude/skills/systematic-debugging.md |
| End of session (user-triggered only) | .claude/skills/session-wrap.md |
| Reading images, PDFs, large JSON, assets | .claude/skills/file-reading-strategy.md |
| Market-data fetch scaffolding (data-agent) | .claude/skills/data-agent.md |
| Dev tool reference (codegraph/markitdown/madge) | .claude/skills/startup.md |
| OpenJev miss→teach→eval | .claude/skills/openjev-train.md |
| Grep patterns for hot files (macro, schema, merge-trusted, nightly-enrichment, cache-registry) | .claude/skills/hot-files.md |
| Backtest / "does X help trades?" | research/studies/PLAYBOOK.md |
| Study judgment (comparators, verdict wording, review packet) | .agents/skills/fildi-quant-research/SKILL.md |
| Data source choice (LSEG/WRDS/Schwab/Polygon/FRED) + budgets | .agents/skills/fildi-market-data/SKILL.md |
| Is a score / rec working? | .agents/skills/fildi-grade-quality/SKILL.md |
| Reviewing a study | research/studies/REVIEW.md |
| "Why is X (not) on the Model List" / rebuild | `scripts/watchlist_sync/funnel.py [--ticker T]` · `rebuild.sh` |
| Agent workflow changes | `.agents/context/workflow-learning.md` + `scripts/workflow_audit.py` |

Subagents: verifier (tsc + tests) · data-agent (fetch/cache) · ui-agent (React). Catalog: `.agents/AGENTS.md`.

## Reading code
1. codegraph first (explore / node / search / impact) before any edit. Route map: `node scripts/route-map.mjs`; commit impact: `scripts/commit-impact.sh <sha>`.
2. Else `grep -n`, then Read with offset+limit. Never whole files; cap output (`| head`).
3. Never read: `node_modules/**`, `dist/**`, lockfiles, `generated/api.ts`. (Tracked `*.mjs` like `scripts/maintain.mjs` are source.)
4. OpenJev savers: > 3 candidate files → `scripts/oj.py files --task "…"`; long output → `oj.py run -- <cmd>`; before analysis → `oj.py studies "<q>"`; before filing ASKS → `oj.py dupes "<idea>"`.

## Token budget
- Cost = session length (the whole context is re-sent every turn). One task per session → update state.md → Jamie runs /clear. Prefer `/compact <keep>` at a task boundary; auto-compact fires at 50 %.
- Write decisions and next steps into state.md when they happen, lessons into memory. Not chat.
- Batch independent calls. Edit with Edit, not whole-file rewrites.
- ASKS.md is a one-line index: open `asks/A##.md` only for rows you act on; closed rows → ASKS-archive.md.
- **Subagents (Jamie 10-16, 7 forks burned the plan):** never `fork`. Default inline. A big build (> ~30 min inline) → ONE fresh agent at a time, `model: sonnet` for mechanical work, short prompt (spec path + acceptance), never parallel.
- **No background waits on external deps (Jamie 10-21):** dependency down (LSEG port 9000, Schwab auth, a login) → probe once, write `blocked: <dep> → run <cmd>` in state.md, tell Jamie in one line, move on. Background only for jobs that finish on their own (build/test/fetch), ≤ 30 min.

## Compact instructions
Keep verbatim: every user message, decisions/approvals (and what was NOT approved), exact paths, symbol names, param versions (e.g. fund-1.1.1), unresolved errors, test baselines, uncommitted files and their owners. Drop: tool output already acted on, file contents, superseded plans.

## Key facts
- All caches use `lib/ttl-cache.ts` (TTL table + registry: caching-patterns skill). Field priority: `scripts/merge-trusted.ts` FIELD_DEFS. API catalog: `.agents/context/api-endpoints.md`.
- Universe = `fmp_fundamentals` table. Never hardcode a ticker count.
- Hooks live in `.claude/settings.local.json` only (just the Read guard). `.claude/hooks/hooks.json` is not read.
