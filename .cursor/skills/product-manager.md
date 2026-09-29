---
name: product-manager
description: PM workflow for TradeDash — token-efficient bootstrap, backlog writing to .cursor/tasks/, competitive research on demand.
---

Load when user invokes PM mode. Follow `.cursor/rules/product-manager.mdc` write boundaries.

---

## Startup checklist (token budget: ≤5 reads + 1 codegraph)

1. **Free (hook-injected):** `.cursor/context/cursor-state.md`, `.cursor/context/session.md`
2. **Backlog (if exists):** first 30 lines of `.cursor/tasks/INDEX.md`
3. **Cross-agent pulse (grep only):**
   ```bash
   grep -n "Next tasks\|Blocked\|In progress\|Active work" .agents/context/state.md | head -20
   tail -5 .agents/sessions/INDEX.md
   ```
4. **Code discovery:** ONE `codegraph_explore` scoped to the topic — not broad file sweeps
5. **Deep plan (only if relevant):** grep `.cursor/context/plans/*.md`, then offset-Read the section

**Session mining:** `grep -h "Next:\|Blocked:" .agents/sessions/claude-*.md` for last 14 days — do not load full session files.

---

## Product knowledge (stable — do not re-derive each session)

### What TradeDash is

Institutional-grade **put-selling research** tool. Surfaces CSP/wheel candidates by scoring fundamentals + technicals + options premium + macro regime.

### Stack

| Layer | Path | Notes |
|---|---|---|
| Frontend | `artifacts/stock-compare/` | React 18, Vite, port 8081 |
| Backend | `artifacts/api-server/` | Express ESM, port 8080 — rebuild after src changes |
| DB | `lib/db/` | PostgreSQL, Drizzle ORM |
| Cache | `lib/ttl-cache.ts` | In-memory TTL only (no Redis) |

### Pages (`artifacts/stock-compare/src/App.tsx`)

| Route | Feature |
|---|---|
| `/` | Home — fundamental rankings, stock score |
| `/watchlist` | Watchlist + per-stock analysis |
| `/technical` | Technical leaderboard |
| `/options-scanner` | Put scanner (RSI/MFI + options chain) |
| `/macro` | Macro regime + economic indicators |
| `/portfolio` | Positions / P&L |
| `/breakdown` | Score breakdown |
| `/scorecard-explanation` | Scorecard guide |
| `/settings` | Admin (weights, cache, stock DB) |
| `/profile/:username` | User profile + buckets |
| `/feed`, `/sentiment` | Social / sentiment |

### Scoring layers

| Layer | Symbol / file | Notes |
|---|---|---|
| Fundamental | `computeRankingsV2` — `rankings.ts` | Value 20%, Growth 25%, Quality 35%, Safety 20% |
| Technical | `computeTechnicalRankingsV2` — `technical-rankings.ts` | 6 components (oversold, reversal, vol, trend, options flow, volume) |
| Stock (L1) | `computeStockScore` — `stock-scorer.ts` | tech + fund + relative move + best option + tag |
| Option | options scanner | Strike-level `computeOptionScore` |
| Planned | `.agents/context/plans/fundamental-sector-scoring.md` | Sector-relative peers — partial land; see cursor-state |

### Data sources

Yahoo, FMP, Finnhub, EDGAR, Polygon, Alpha Vantage, FRED, Treasury.gov, FactSet (OCI proxy).

Pipeline: Bronze (per-source staging) → Silver (`source_fundamentals`) → Gold (`ticker_fundamentals`) via `merge-trusted.ts` FIELD_DEFS. Canonical universe: `ticker_registry` WHERE `fetch_fundamentals=true` (~257 tickers).

### Canonical docs (read-only pointers)

| Doc | Use |
|---|---|
| `.agents/context/project.md` | Architecture, tables, data layers |
| `.agents/context/api-endpoints.md` | Route catalog before proposing new APIs |
| `.agents/context/state.md` | Claude build priorities (grep only) |
| `.cursor/context/plans/*.md` | Detailed implementation plans |

Optional later: `.cursor/context/product-map.md` when this section outgrows the skill.

---

## Task PRD template (use for scoped tasks)

Each actionable task file should include these sections:

1. **Executive summary** — one paragraph scope
2. **Why** — user problem, business outcome, competitive benchmark
3. **What** — in-scope table + explicit out-of-scope / defer list
4. **How** — architecture diagram (ASCII/mermaid), English logic for key flows
5. **Data sources & API impact** — what fetches, rate limits, DB tables (or "none")
6. **Caching & performance** — TTL, localStorage vs DB, duplicate-fetch prevention
7. **Existing code to reuse** — paths, what not to rebuild
8. **Implementation breakdown** — checkbox subtasks with exact files
9. **Agent routing & skills** — ui-agent / data-agent / verifier
10. **Verification** — manual test table + commands
11. **Bug mitigation** — edge cases with mitigations
12. **Risks & dependencies**
13. **Expected files touched**

Reference implementation: `.cursor/tasks/2026-07-09-onboarding-product-tour.md`

---

## Task schema (inline — use when writing tasks)

**File naming:** `.cursor/tasks/YYYY-MM-DD-<slug>.md`

```markdown
# <slug>
**Status:** backlog | ready | in-progress | blocked | done
**Priority:** P0 | P1 | P2 | P3
**Area:** data | api | ui | scoring | macro | infra | research
**Created:** YYYY-MM-DD
**Source:** session-mining | user-request | competitive-research | tech-debt

## Problem
One paragraph — user / job-to-be-done.

## Current state
What exists today (codegraph paths, not guesses).

## Proposed outcome
Testable acceptance criteria.

## Dependencies / blockers
API quotas, migrations, upstream features.

## Implementation hints (optional)
Likely files; builder agents per `.agents/AGENTS.md` (read-only).

## Competitive context (optional)
1–2 sentences + links if researched.

## Effort
S | M | L | XL
```

### INDEX.md format (create when first tasks exist)

```markdown
# PM Backlog

| P | Status | Slug | Area | Effort | Updated |
|---|---|---|---|---|---|
| P0 | backlog | example-slug | ui | M | YYYY-MM-DD |

Open tasks link to `YYYY-MM-DD-<slug>.md`. Done → move to `archive/`.
```

**Lifecycle:** maintain priority order in INDEX; archive done tasks to `.cursor/tasks/archive/` after user confirms ship.

---

## Research protocol (on demand only)

Trigger: user asks for ideation, competitive scan, or task `Area: research`.

1. Pick 2–3 comparable products (e.g. OptionStrat, Barchart Options, Koyfin, Robinhood analyst tools)
2. **One** `WebSearch` per product category — not per feature
3. Cross-reference gaps against product knowledge above
4. Output: task file(s) in `.cursor/tasks/` with `Source: competitive-research`
5. Optional `Task` subagent only if comparing 4+ products in one request

---

## Session end

- Update `.cursor/tasks/INDEX.md` if tasks changed
- Do **not** edit `.agents/context/state.md`, `.claude/**`, or `cursor-state.md` unless user explicitly requests build-handoff sync
