# TradeDash — Cursor Config
> Cursor only. Shared product/ops SoT lives in `.agents/`. Session state via `sessionStart` hook.
> After the user confirms a plan (or says implement/proceed), **execute** — do not stay in plan-only mode.

## STARTUP (every new chat)
1. Context is auto-injected by `.cursor/scripts/session-start.js` (runs `agent-git-sync.sh` first, then phase/tasks/git/codegraph banner). Sets `FILDI_AGENT=cursor` for child processes.
2. If banner missing, run: `node .cursor/scripts/rehydrate-cursor.js` then `scripts/agent-git-sync.sh`
3. **Team bus is sync'd in step 1** — do not hand `git pull` / stash / rebase (AGENTS.md rule 2). If Sync line says behind/conflict, fix via the script only.
3b. **Learn ritual (A209):** `bash scripts/agent-learn.sh cursor` — skim top waste turns; prefer oj/codegraph when loop/Acts high.
4. Read open **`research/common/ASKS.md`** rows **Muse → Cursor** (and Cursor → Muse). **Cursor owns all Muse handoffs** (user 2026-10-07) — Claude does not implement them. ASKS.md is a one-line index — details/replies/reviews in `research/common/asks/A##.md` (open only rows you act on; update the index status word). `[quant]` rows: build from status `planned` (Claude's plan review), or after 48 h without it. Commit with `Refs: A##` + `Agent: cursor` when the build finishes — do not ask Jamie whether to commit agent-bus work. See `AGENTS.md` § Review loop. Adapter: `MUSE.md`
4c. **Drain without re-asking (Jamie 10-28):** “finish / continue / what's next / Ideas assigned to you” = claim next open/planned Cursor row → implement → ship-check → commit → `agent-git-sync` → next row. **Never** stop to ask “commit?” / “continue?” / “want me to…?”. Only stop for real blockers (missing secret, vendor down, scoring change needing a number Jamie must pick). Keep `.cursor/context/drain-queue.md` + `cursor-state.md` current.
4b. **Ship gate (Jamie 2026-10-18 / A94):** before any commit that touches `artifacts/api-server/src/**` or `artifacts/stock-compare/src/**`, run `scripts/agent-ship-check.sh` (typecheck; healthz warn). `agent-git-sync.sh` also runs it before push. Wrong middleware imports crash the whole API — never skip. No loops/subagents for ship automation.
4d. **UI tabs/type (A305):** new tab bars use `@/lib/sub-tabs` (or Radix `ui/tabs` which skins it). No bespoke tab-bar, no Google Fonts CDN, no `font-family` outside `index.css`. Guard: `node scripts/ui-style-guard.mjs` (wired into ship-check).
5. Shared map: **`.agents/context/INDEX.md`** (also root **`AGENTS.md`**)
6. Task code context: **codegraph** MCP
7. **NEEDS YOU inbox (A153):** `node .agents/hooks/needs-inbox.mjs --agent=cursor` — unanswered Jamie comments; reply with `needs-reply.mjs J# "…" cursor` (Owner does the work; Muse is default first responder)

## PROJECT RULES (`.cursor/rules/`)
**Policy:** default `alwaysApply: false`. A **4th** always-on rule needs explicit user approval (R1).

| Rule | alwaysApply | Purpose | Invoke |
|---|---|---|---|
| `cursor.mdc` | Y | Thin entry → CURSOR.md | auto |
| `codegraph.mdc` | Y | Codegraph before multi-file reads/refactors | auto |
| `token-efficiency.mdc` | Y | Compress long prompts/responses | auto |
| `lessons-learned.mdc` | N | Grep lessons before repeating infra mistakes | say “check lessons” |
| `ui-density.mdc` | N (globs stock-compare) | One-line status strips; Radix tips not `title=` | auto on UI files |
| `product-manager.mdc` | N | Backlog / task writing | say “PM mode” |
| `task-reviewer.mdc` | N | PRD/DoR review of `.cursor/tasks` | say “review this task” |

Floors: `.agents/context/agentic-floors.md`.

## AGENTS (routing)
Root ToC: [`AGENTS.md`](AGENTS.md). Subagent catalog: [`.agents/AGENTS.md`](.agents/AGENTS.md).  
Use Task `verifier` / `data-agent` / `ui-agent` when scoped — not an orchestrator fan-out (R3).

## MCP
| Server | Use |
|---|---|
| `codegraph` | `explore` / `search` / `callers` / `node` |

## SESSION CONTEXT
Prefer **`.agents/context/INDEX.md`**. Always-injected: `cursor-state.md` + `session.md`. Cursor **never** writes `.agents/context/state.md`.

## END OF SESSION
1. `node .cursor/scripts/session-wrap-cursor.js "what we did"`
2. Update `.cursor/context/cursor-state.md`
3. Never edit `.agents/context/state.md`

## SKILLS (load **one** at a time)
Same bodies as Claude: `.claude/skills/<name>.md`. Cursor wrap ≠ Claude `session-wrap` skill.

| Need | Skill |
|---|---|
| Build + restart (Mac) | `local-mac-dev.md` |
| Build + restart (Replit only) | `build-and-run.md` |
| Data fetch / tiers / TTL | `data-architecture.md` |
| Yahoo / TTLCache | `caching-patterns.md` |
| API route / middleware | `api-design-patterns.md` |
| Options chain | `options-pricer.md` |
| RSI/MFI scanner (not Model List) | `signal-filters.md` |
| Model List / fit / watchlist_sync | `model-list.md` |
| Fildi app UI (GRID_*, no grey) | `ui-components.md` |
| **UI chrome trim** (Scorecard presets/blurbs/bars/FAB — Jamie repeats) | `.cursor/skills/ui-chrome/SKILL.md` (+ `.claude/skills/ui-chrome.md`) |
| DB schema / queries | `db-patterns.md` |
| Trader strategy | `trader-context.md` |
| Technical scorecard | `technical-scorecard.md` |
| TradingView indicators (UT Bot, SuperTrend, SMC, Fear & Greed) — one home `indicators.py`, tests, use cases | `.agents/context/indicators.md` |
| Feature planning | `feature-planner.md` |
| Implementation plans | `writing-plans.md` |
| Debugging | `systematic-debugging.md` |
| Large files / PDFs | `file-reading-strategy.md` |
| Yahoo/Redis scaffolding | `data-agent.md` |
| Weekly data-ops audit | `data-ops-auditor.md` (+ `.cursor/skills/weekly-data-ops-check.md`) |
| Dev tools (codegraph/madge) | `startup.md` |
| OpenJev miss→teach→eval | `openjev-train.md` |
| Studies / backtests / scenario analysis (judgment) | `.agents/skills/fildi-quant-research/SKILL.md` · screen first: `research/studies/PLAYBOOK.md` § 0 (`analysis/fast_screen.py`) |
| Data source choice + vendor budgets | `.agents/skills/fildi-market-data/SKILL.md` |
| Score / recommendation quality | `.agents/skills/fildi-grade-quality/SKILL.md` |
| Market / sector thesis (claim tree, analogs, money flows, scenarios) | `.agents/skills/fildi-market-thesis/SKILL.md` |
| Replit-only setup | `replit-setup.md` (skip on Mac) |
| Claude session wrap | `session-wrap.md` — Claude only |

Multi-agent bus / ASKS / `agent-git-sync` / ship-check: **AGENTS.md** (not a skill).

## CODEGRAPH
MCP: prefer `explore` with a tight query. CLI: `codegraph context` · `impact` · `sync`.

## CURSOR vs CLAUDE
| | Cursor | Claude Code |
|---|---|---|
| Shared ToC | `AGENTS.md` + `.agents/context/INDEX.md` | same |
| Entry adapter | `CURSOR.md` + `.cursor/rules/` | `CLAUDE.md` |
| Phase state | `cursor-state.md` (write) | `state.md` (write) |
| Cross-agent ops SoT | `.agents/context/*` (shared write OK) | same |
| `state.md` | **read-only** | write |
