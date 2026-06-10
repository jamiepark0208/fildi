# Phase Report: Multi-Agent Context Management
**Date:** 2026-06-10  
**Scope:** Context architecture, agentic workflow, Kiro integration  
**Status:** Complete

---

## What Was Built

### Problem
TradeDash used Claude Code as its sole AI agent. All context (skills, hooks, docs, state) lived in `.claude/` which was entirely gitignored. Adding Kiro as a parallel agent was impossible — it had no access to any project context.

Secondary problem: two duplicate memory systems, an 800-line CLAUDE.md, and no structured way to hand work between agents.

### Changes Made (6 commits, 2026-06-10)

| Commit | Change |
|---|---|
| `1879249` | Fixed `.gitignore`: replaced `**/.claude` with targeted ignores for `settings.local.json` + `state.json` only. All skills, docs, hooks, scripts now git-tracked. |
| `95532dc` | Consolidated `memory/` into `.agents/memory/`. Single memory index, 4 entries. |
| `af7bcab` | Added `.agents/tasks/` for cross-agent task tracking. |
| `c36b2b2` | Created `.kiro/steering/` with 3 files for Kiro auto-context. |
| `105e776` | Created `.kiroignore` to exclude build artifacts from Kiro's file indexing. |
| `615a789` | Refactored: full content moved to `.agents/context/` (canonical source). `.kiro/steering/` files became thin stubs pointing there. |
| `bf59628` | `session-wrap.js` extended: syncs `.kiro/steering/03-state.md` + `.agents/context/state.md` on every Stop; writes `.agents/sessions/YYYY-MM-DD.md`; upserts `INDEX.md`. |
| `951267b` | Removed hardcoded ticker lists from context files — reference `watchlist` DB table instead. |
| `abf2cf6` | State sync verification pass. |
| `c057a80` | Agent specs enhanced (capabilities, constraints, escalate_to); `.agents/AGENTS.md` created (catalog + handoff protocol + guardrails); CLAUDE.md trimmed 137→58 lines; FILDI_ROADMAP.md created; session history backfilled. |
| `[current]` | workflow.md: added codegraph section, skills usage, hook equivalents table. technical-scorecard.md: updated to V2 architecture. |

---

## Final Architecture

```
.agents/                           ← canonical source, git-tracked, any agent reads this
  AGENTS.md                        ← agent catalog, decision tree, handoff protocol, guardrails
  context/
    project.md                     ← architecture, scoring, data sources, DB tables
    workflow.md                    ← build rules, routing, debugging, model routing, hooks table
    state.md                       ← phase/tasks (auto-synced on Claude Code Stop)
  memory/
    MEMORY.md                      ← index (4 entries)
    api-server-port-conflict.md
    express-route-ordering.md
    yahoo-finance2-options.md
    feedback-reading-rules.md
  tasks/                           ← active cross-agent task files
  sessions/
    INDEX.md                       ← rolling one-line-per-day summary
    2026-06-08.md ... YYYY-MM-DD.md

.claude/                           ← Claude Code-specific (now git-tracked)
  skills/                          ← 12 skill files (Skill tool + readable by Kiro)
  agents/                          ← sub-agent specs (verifier, data-agent, ui-agent)
  hooks/                           ← prompt-preprocessor.js, context-monitor.js
  scripts/                         ← rehydrate.js, session-wrap.js
  settings.local.json              ← gitignored (hooks config, API keys)
  state.json                       ← gitignored (ephemeral session state)

.kiro/steering/                    ← Kiro auto-loads on every prompt
  01-project.md                    ← stub → .agents/context/project.md + 5 key facts
  02-workflow.md                   ← stub → .agents/context/workflow.md + build command inline
  03-state.md                      ← full state inline (auto-synced by session-wrap.js)

CLAUDE.md                          ← 58 lines, Claude Code entry point only
FILDI_ROADMAP.md                   ← pending features, known issues, architectural decisions
.kiroignore                        ← excludes node_modules, dist, binary assets, .codegraph
```

---

## Token Optimization Aspects (what's good)

### 1. Layered loading — professional pattern
Agents don't get all context on every prompt. They load what's relevant:
- Session start: CLAUDE.md (58 lines) + session state via rehydrate.js banner
- Kiro start: 3 steering files (total ~50 lines of stub) auto-loaded
- On-demand: skills loaded only when relevant (Claude Code Skill tool or manual read for Kiro)

This mirrors how Cognition/Devin, Cursor, and Copilot Workspace handle context. The key insight is: **start sparse, load dense only when needed**.

### 2. Session state is JSON, not markdown
`state.json` is ground truth. Markdown files (`state.md`, `03-state.md`) are rendered views synced by `session-wrap.js`. No agent ever writes to markdown state directly — they write to JSON and the sync propagates it.

### 3. Context window monitoring
`context-monitor.js` (PostToolUse hook) warns at 40% and 60% context fill. `AUTOCOMPACT_PCT_OVERRIDE=45` triggers automatic compaction. Claude Code users get proactive warnings before hitting limits.

### 4. Prompt optimization hook
`prompt-preprocessor.js` (PreToolUse on Task/TodoWrite) catches:
- Haiku-tier tasks (fetch, scaffold, boilerplate) → route to cheaper model
- Opus-tier tasks (/opus, redesign entire) → confirm before expensive call
- Prompts > 120 words → suggest moving to a skill file
- Options chain mentions without cache → remind about cache-first policy

### 5. Skills as reusable context chunks
12 skill files replace inline instructions that would otherwise repeat in every relevant prompt. Estimated savings: 300-500 tokens per session for frequently-used domains.

### 6. Git-tracked context enables reproducibility
All context is version-controlled. Any agent cloning the repo gets full project history, skill files, and agent specs. Previously this was all local-only.

---

## Remaining Inefficiencies (not yet addressed)

### 1. No API endpoint catalog
Agents starting a new feature have no machine-readable list of existing routes. They must `grep` the source or read route files. A `.agents/context/api-endpoints.md` with a route table would save 2-5 file reads per feature task.

### 2. Model routing is advisory only for Kiro
The model routing table in `workflow.md` tells Kiro "use haiku for data fetching" but Kiro can't actually switch models within a session. It uses whatever model the user selected at project open. The table is documentation, not enforcement.

### 3. Hooks don't run for Kiro
The four Claude Code hooks (prompt-preprocessor, context-monitor, session-wrap, rehydrate) are fully automatic for Claude Code but manual suggestions for Kiro. The `workflow.md` hook equivalents table documents what to do, but compliance depends on Kiro's behavior — it won't automatically check model routing before tasks.

### 4. Inter-agent state sharing is file-based, not event-based
When Kiro finishes a component and writes a `.agents/tasks/` file, Claude Code doesn't get notified. It has to check the tasks folder. A proper multi-agent system would use a message queue or webhook. Current approach works for sequential handoffs but not true parallelism.

### 5. Memory has no retrieval mechanism
`.agents/memory/` is a flat file system. Agents read `MEMORY.md` (index) then fetch specific files. For 4 entries this is fine, but as lessons accumulate past ~20 entries, this becomes slow. No vector search or semantic retrieval.

### 6. ivRank/ivPercentile are proxies
Both use realized volatility as an IV proxy. True IV rank requires ~60 days of `atmPutIv` history to accumulate in `tickerTechnicals`. Until then, volatility state scoring is approximate.

### 7. scorecard-explanation.tsx still shows V1 metrics
The explainer UI page hasn't been updated to reflect V2 component weights. Users see old signal descriptions when they click "explain."

### 8. No integration tests for scorer pipeline
Unit tests cover individual scorer functions, but there's no end-to-end test: prices_historical → computeTechnicalRankingsV2 → tickerTechnicals → /api/technicals/all → UI. A regression in any step would be caught only visually.

---

## How This Compares to Professional Agentic Development

### What we do well
| Practice | Status |
|---|---|
| Layered context loading | ✓ Implemented |
| Git-tracked context | ✓ Implemented (uncommon — most setups are local-only) |
| Sub-agent specs with constraints | ✓ Implemented |
| Auto session save/restore | ✓ Implemented |
| Context window monitoring | ✓ Implemented |
| Prompt routing hints | ✓ Implemented (Claude Code only) |
| Canonical single-source context | ✓ Implemented (.agents/context/) |
| Agent handoff protocol | ✓ Documented (AGENTS.md) |

### What professional systems have that we don't
| Practice | Gap |
|---|---|
| Event-based agent coordination | File-based polling instead |
| Semantic memory retrieval | Flat file system |
| Full API endpoint catalog | Missing |
| End-to-end integration tests | Missing |
| True IV rank (not proxy) | Pending data accumulation |
| Typed state schemas | JSON is untyped, markdown is freeform |
