# TradeDash — Claude Code Config
> Claude Code only. Full project context in .agents/. State restored on every prompt via rehydrate hook.

## STARTUP (every session)
Run: node .claude/scripts/rehydrate.js
First time only: read .claude/skills/replit-setup.md and follow the steps

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
| End of session | .claude/skills/session-wrap.md |
| Reading images, PDFs, large JSON, assets | .claude/skills/file-reading-strategy.md |


---

## AGENTS
verifier = tsc + lint + tests | data-agent = fetch/cache | ui-agent = React components
Full catalog: .agents/AGENTS.md

## CODEGRAPH
Use before touching any source file. codegraph auto-runs on Edit/Write via hook.
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
- If context > 40%: use /compact before starting a new large task
- Auto-compact fires at 45% (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=45) — do not fight it

## KEY FILES (updated 2026-06-18)
- Security middleware: `middleware/rateLimiter.ts`, `middleware/errorHandler.ts`, `middleware/validate.ts`
- Shared cache utility: `lib/ttl-cache.ts` — all caches use this; see `.claude/skills/caching-patterns.md` for TTL table + registry rules
- Auth validators: `lib/validators/auth.ts` (Zod schemas for register/login)
- Admin endpoints: `routes/admin-cache.ts`, `routes/auth.ts` (invite CRUD)
- Full API catalog: `.agents/context/api-endpoints.md`

## HOOKS
Defined in .claude/settings.local.json — never in .claude/hooks/hooks.json (not read).
