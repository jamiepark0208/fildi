@AGENTS.md

# TradeDash — Claude Code Config
> Claude Code only. Shared product/ops SoT: `.agents/context/INDEX.md` (also root `AGENTS.md`). Session state lives in `.agents/context/state.md` — read it when resuming work.

## RESPONSE STYLE
Be concise. Never echo back code just written or commands just run — the user sees tool output directly. State what was done in plain English, 1-2 sentences per action. No code blocks in prose unless explicitly asked. No repeating file paths/flags verbatim.

## STARTUP (every session)
No per-prompt hook (rehydrate was dropped 2026-10-06: ~2 s latency per prompt for a stale one-liner). Only hook: the Read guard (PreToolUse) in `.claude/settings.local.json`.
Run once per session: `node .claude/scripts/validate-workflow.js`
Then sync: `git fetch origin` → `git pull --ff-only` if behind (never over uncommitted work: check `git status` first) →
read open `research/common/ASKS.md` rows addressed **to Claude** →
review loop (`AGENTS.md` § Review loop, user 2026-10-11): (a) plan-review open `[quant]` Muse rows → append `**Claude plan <date>:**` + eval, status `planned`;
(b) `git log <Last reviewed SHA in state.md>..HEAD` → review quant diffs (`Refs: A##`) **before** reading Muse's review → `**Claude review <sha>:**` on the row; update the SHA.
**Never implement** Muse rows — Cursor owns them (user 2026-10-07).
First time only: read .claude/skills/replit-setup.md and follow the steps
Build/restart questions → `.claude/skills/build-and-run.md` (has the correct restart procedure — don't improvise)
Shared retrieval map → `.agents/context/INDEX.md` (do not load all context files)

## SKILLS (load one at a time — never all at once)
| Need | Skill |
|---|---|
| Build + restart server | .claude/skills/build-and-run.md |
| Data fetch strategy / tiers / TTL decisions | .claude/skills/data-architecture.md |
| Any Yahoo Finance / TTLCache work | .claude/skills/caching-patterns.md |
| New API route or middleware | .claude/skills/api-design-patterns.md |
| Options chain fetch | .claude/skills/options-pricer.md |
| RSI/MFI/filter logic | .claude/skills/signal-filters.md |
| UI components | .claude/skills/ui-components.md |
| DB schema and queries | .claude/skills/db-patterns.md |
| Trader strategy/scoring | .claude/skills/trader-context.md |
| Technical scorecard | .claude/skills/technical-scorecard.md |
| Feature planning | .claude/skills/feature-planner.md |
| Implementation planning | .claude/skills/writing-plans.md |
| Debugging any bug/failure | .claude/skills/systematic-debugging.md |
| End of session — user-triggered only, at ~90-95% context, never automatic | .claude/skills/session-wrap.md |
| Reading images, PDFs, large JSON, assets | .claude/skills/file-reading-strategy.md |
| Yahoo/Redis fetch scaffolding (data-agent subagent conventions) | .claude/skills/data-agent.md |
| Dev tool reference (codegraph/markitdown/madge usage) | .claude/skills/startup.md |


---

## AGENTS
verifier = tsc + lint + tests | data-agent = fetch/cache | ui-agent = React components
Full catalog: .agents/AGENTS.md

## CODEGRAPH
Use before touching any source file (call it yourself — no hook runs codegraph automatically; the Read-guard hook only warns on untargeted reads).
- codegraph context "<task>" — symbols + callers before any edit; use `maxNodes:10` to limit output
- codegraph impact <symbol> — what breaks before changing a function
- For a specific symbol body: `codegraph_node` with `includeCode:true`; for broad mapping: `includeCode:false`

**Fallback chain (in order — do NOT skip steps):**
1. codegraph tools first (codegraph_context, codegraph_node, codegraph_search)
2. If codegraph unavailable/returns nothing → grep/find for the specific symbol or pattern
3. If grep is insufficient → use grep/codegraph to find the exact line numbers first, then Read with offset+limit (never load the whole file)
   Never read at all — no value, always noise:
   - `node_modules/**`
   - `dist/**`, `*.mjs` (compiled output)
   - `pnpm-lock.yaml`, `package-lock.json`, `generated/api.ts`

## CONTEXT MANAGEMENT
- If a prompt > 120 words: load the relevant skill file before responding — don't derive from memory
- Auto-compact fires at 25% (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in settings.local.json) — do not fight it
- Cost driver is session length (whole context re-sent each turn), not md files. One task per session: update state.md, then the user runs /clear
- Read code with codegraph or `grep -n` + small ranges; never `cat`/`sed` whole files. Cap command output (`| head`, `tail -20`)
- Batch independent commands into one turn; edit with Edit, not rewrite heredocs of whole files
- research/common/ASKS.md: read open rows only; move closed rows to ASKS-archive.md
- Facts that must survive compaction go in files, not chat: decisions/next steps → state.md, durable lessons → memory. Write them when they happen, not at the end
- Prefer a deliberate `/compact <what to keep>` or /clear at a task boundary over letting auto-compact fire mid-task

## COMPACT INSTRUCTIONS
When summarizing this conversation, keep verbatim: every user message, the user's decisions and approvals (and what they did NOT approve), exact file paths, symbol names, param versions (e.g. fund-1.1.1), error messages still unresolved, test baselines, and uncommitted files and who owns them. Drop: tool output already acted on, file contents (re-read on demand), superseded plans.

## KEY FILES (updated 2026-07-05)
- Security middleware: `middleware/rateLimiter.ts`, `middleware/errorHandler.ts`, `middleware/validate.ts`
- Shared cache utility: `lib/ttl-cache.ts` — all caches use this; see `.claude/skills/caching-patterns.md` for TTL table + registry rules
- Auth validators: `lib/validators/auth.ts` (Zod schemas for register/login)
- Admin endpoints: `routes/admin-cache.ts`, `routes/auth.ts` (invite CRUD), `routes/fundamentals-provenance.ts` (provenance + overrides)
- Fundamentals pipeline: `scripts/merge-trusted.ts` (FIELD_DEFS — single source of truth for field priority), `lib/fundamentals-db.ts`
- Full API catalog: `.agents/context/api-endpoints.md`
- DB canonical universe: `fmp_fundamentals` table — **never hardcode a ticker count**; query the table for the live count

## HOT FILE INDEX — grep before Read, never load whole file
These files are edited frequently. Always `grep -n "<pattern>" <file>` to get line numbers, then `Read offset+limit`.

| File (path relative to artifacts/) | Find what | Grep pattern |
|---|---|---|
| `api-server/src/lib/macro-data.ts` | MacroCharts interface | `grep -n "MacroCharts\|interface Macro"` |
| `api-server/src/lib/macro-data.ts` | fetchMacroCharts body | `grep -n "fetchMacroCharts\|Promise.allSettled"` |
| `api-server/src/lib/macro-data.ts` | loadChartsCache guard | `grep -n "loadChartsCache\|in data"` |
| `api-server/src/lib/macro-data.ts` | fetchMacroData body | `grep -n "fetchMacroData\|ismManufacturing"` |
| `api-server/src/lib/macro-static.ts` | INDICATOR_SERIES entries | `grep -n "INDICATOR_SERIES\|ismManufacturing"` |
| `stock-compare/src/pages/macro.tsx` | regime tab charts section | `grep -n "HY Credit\|IG/HY\|NFCI\|DXY\|Economic Indicators"` |
| `stock-compare/src/pages/macro.tsx` | macro component imports | `grep -n "DualLine\|RateHistory\|import {"` |
| `stock-compare/src/components/macro/macro-history-charts.tsx` | DualLineHistoryChart / RateHistoryChart | `grep -n "DualLine\|RateHistoryChart\|referenceLines"` |
| `stock-compare/src/components/macro/macro-page-types.ts` | MacroCharts / MacroData types | `grep -n "MacroCharts\|MacroData\|igSpread\|nfci"` |
| `lib/db/src/schema/index.ts` (repo root, NOT under artifacts/) | any table definition | `grep -n "pgTable\|market_regime"` |
| `api-server/src/scripts/merge-trusted.ts` | FIELD_DEFS priority table | `grep -n "FIELD_DEFS\|tfCol\|priority"` |
| `api-server/src/scripts/nightly-enrichment.ts` | per-source fetchX() write bodies — check for dropped fields vs the source's *-client.ts interface before trusting coverage numbers | `grep -n "^async function fetch"` |
| `api-server/src/lib/cache-registry.ts` | registered cache names | `grep -n "DISPLAY_NAMES\|getAllCaches"` |

## HOOKS
Defined in .claude/settings.local.json — never in .claude/hooks/hooks.json (not read).
