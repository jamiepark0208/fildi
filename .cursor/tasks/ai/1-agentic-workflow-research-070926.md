# agentic-workflow-research

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P0 |
| **Area** | research |
| **Created** | 2026-07-09 |
| **Source** | user-request (agentic audit) |
| **Blocks** | All `agentic-*` and `product-ai-*` PRDs below |

---

## 1. Executive summary

TradeDash already has (a) a Cursor/Claude **dev agent harness** and (b) thin **product AI** (explain, daily brief, provenance). Groundbreaking AI apps win by putting models *inside* trusted workflows with explainability and feedback loops — not by bolting on chat or multi-model orchestration. This research defines what to steal, what to SKIP, an enhance-first matrix, and **shared risk floors** every PRD must reference.

**Deliverable of this track:** task markdown only. No app code until a build session.

---

## 2. What “groundbreaking” means (2025–2026)

Winners share one of:

1. **AI inside the job** — editor, diligence grid, portfolio engine (not a naked chatbot)
2. **New form factor** — botless notepad, public gallery, docs×prompts matrix
3. **Measure → improve loop** — failed conversations / closed trades become structured memory

Generic “ask GPT about X” is table stakes.

---

## 3. Creative AI apps synthesis (deep brief)

### Category A — Agents that do work

| App | Why groundbreaking | Steal for FILDI | Do not copy |
|---|---|---|---|
| **Cursor** | AI in the editor; rules/skills/hooks; human steers | Parity + hygiene of existing stack | 8-agent parallel fan-out / orchestrator |
| **Claude Code** | Hooks *guarantee* gates (codegraph, wrap) | Port deterministic hooks → Cursor | Duplicate full Claude product |
| **Devin / Cognition** | Async delegation: brief → cloud → PR | Later for well-scoped migrations only | Unattended money / auto-trade |
| **ChatGPT Work** | Goal → multi-hour project; model tiers for cost | Right model for job (Haiku explain vs stronger build) | Full Work-agent platform in TradeDash |
| **Perplexity Computer** | Sub-agents + model routing for long workflows | Idea only: route explain vs research vs code | 19-model orchestration / Max-tier cost |

### Category B — Creative / form-factor

| App | Why groundbreaking | Steal for FILDI | Do not copy |
|---|---|---|---|
| **Midjourney** | Public Discord creation; social learning | Social learning from feed ideas — AI not the hero | Discord-as-UI for trading |
| **Granola** | Botless capture; human notes *steer* LLM | Human thesis tags steer journal summaries | Always-on audio of traders |
| **Hebbia Matrix** | Docs × prompts grid; citations; multi-agent extract | Provenance / Stock DB as questions over trusted fields | Agent swarm over full DB dumps |
| **Harvey** | Domain-grounded legal copilot | Domain prompts over CSP/scorecard language | Fine-tuned “AGI” clone |
| **Runway / ElevenLabs** | New media primitives | N/A for core product | Media-gen feature bloat |

### Category C — Knowledge in *your* artifacts

| App | Why groundbreaking | Steal for FILDI | Do not copy |
|---|---|---|---|
| **Glean** | Permission-aware graph; context beats naked ChatGPT | Ask over *this ticker’s* provenance + scores | Index Slack/email into TradeDash |
| **Notion AI** | Q&A in workspace with citations | DQ chat *in* Stock DB / freshness UI | Global free-form chatbot + DB dump |
| **Linear AI** | Ask in context of the issue | Explain on scanner/home *card* | Separate AI tab with no object |

### Category D — Finance AI that isn’t vapor

| App | Why noteworthy | Steal for FILDI | Do not copy |
|---|---|---|---|
| **PortfolioPilot** | AI on top of allocation/risk engines | Wire explain to existing scores | “Financial AGI” / replace scoring |
| **Magnifi** | Conversational research + holdings | NL over portfolio + scores | Become a brokerage |
| **Composer** | NL → rules → backtest → execute | NL → *explain* existing CSP rules | Auto-execute options |
| **TipRanks-class** | Diagnostics on *your* holdings | Extend PortfolioAnalysis + Daily Brief | Opaque new score model |
| **Danelfin / Fiscal.ai** | Clear scores + research | Explain + peer context (you already score) | Duplicate third-party vendor |

### Category E — Continuous improvement loops

| App | Why groundbreaking | Steal for FILDI | Do not copy |
|---|---|---|---|
| **Intercom Fin** | Analyze → Train → Test → Deploy | Trade journal: failed thesis → tagged lesson → retrieve | Silent fine-tune on user trades |
| **Sierra** | Conversation mining → A/B experiments | Dev `lessons.md` + trader journal as *explicit* memory | Auto-rewrite prod prompts without review |

### Cross-cutting principles

1. Thin layer over trusted systems (scores, provenance, journal, rules)
2. Artifact-local AI (this card / ticker / closed trade)
3. Human confirmation for money-adjacent outputs
4. Right model / right job — no multi-vendor orchestration theater
5. Measure → improve loops — not always-on mega-memory
6. Form factor matters (grid, card, brief, hook)

---

## 4. Dev stack inventory (baseline)

| Layer | Cursor today | Claude today | Gap |
|---|---|---|---|
| Entry | `CURSOR.md` | `CLAUDE.md` | Keep dual; bridge via pointers |
| Hooks | `.cursor/hooks.json` → **sessionStart only** | `codegraph-precheck.js` + settings.local (rehydrate, wrap, etc.) | Cursor missing PreToolUse/Stop parity |
| Scripts | `rehydrate-cursor`, `session-wrap-cursor`, `session-lesson-cursor`, `session-start` | `rehydrate`, `session-wrap`, `validate-workflow` | Commands/playbooks thin |
| Rules | `codegraph`, `token-efficiency` alwaysApply; `lessons-learned`, `product-manager` on demand | Skills table in CLAUDE.md | Scope/trim alwaysApply; avoid bloat |
| Skills | `.claude/skills/*` + `.cursor/skills/product-manager.md` | Same skills tree | Discovery index, not always-load |
| MCP | codegraph only (`.cursor/mcp.json`) | — | Prefer **zero** new MCP |
| Agents | Task tool types; no local orchestrator | `verifier`, `data-agent`, `ui-agent` in `.claude/agents/` | Verifier gate playbook |
| State | `.cursor/context/cursor-state.md`, `session.md`, `lessons.md` | `.agents/context/state.md` | **Cursor never writes state.md** |
| Memory | `lessons.md` max 15 | `.agents/memory/*` | Hygiene + no conflation with trader journal |

---

## 5. Product AI inventory (baseline)

| Surface | Path / API | Notes |
|---|---|---|
| Score explain | `POST /api/explain/score` — `artifacts/api-server/src/routes/explain.ts` | Haiku, max_tokens 200; fundamental + technical only |
| Deterministic CSP reason | `buildReasoning()` in `options-scanner.tsx` | Not LLM — must stay source of truth for signal line |
| Daily brief | `daily-brief.ts` + `daily-brief.tsx` | Portfolio; reuse — no second LLM pipeline |
| Provenance | `GET /api/fundamentals/provenance/:ticker` (admin) + `StockDBTab.tsx` | Admin DQ surface |
| Macro / bank research AI | Existing macro highlights paths | Do not duplicate |
| Feed / profile | Human trade ideas + close | Journal loop enhances these |
| Related ready tasks | `contextual-score-explanations`, `data-freshness-monitoring`, portfolio/feed drafts | Enhance, don’t fork |

---

## 6. Enhance-first matrix

| Planned PRD | Existing to enhance | Related backlog | Truly NEW? |
|---|---|---|---|
| `agentic-cursor-hooks-parity` | Claude PreToolUse codegraph-precheck; Cursor sessionStart + scripts | — | NEW hooks wiring only |
| `agentic-scoped-rules-trim` | `.cursor/rules/*` alwaysApply set | token-efficiency, codegraph | Trim/scope |
| `agentic-skills-discovery` | `.claude/skills/*`, CURSOR.md table | — | Index/stubs |
| `agentic-commands-playbooks` | wrap / lesson / rehydrate scripts | — | Thin wrappers |
| `agentic-mcp-selective` | codegraph-only mcp.json | — | Prefer zero new |
| `agentic-agents-md-bridge` | `.agents/AGENTS.md`, CURSOR.md | — | Pointer only |
| `agentic-verifier-gate` | `.claude/agents/verifier.md` | ci-pipeline, api-integration-test | Playbook to run existing |
| `agentic-lesson-memory-hygiene` | `lessons.md`, `.agents/memory/` | lessons-learned rule | Policy + sync map |
| `agentic-safety-context-isolation` | Cursor never writes state.md; MCP allowlist | lessons L-01/L-04 | Docs + light guards |
| `product-ai-explain-csp` | explain API + `buildReasoning` + contextual-score | contextual-score, scanner, home | UI surface / CSP wiring |
| `product-ai-data-quality-chat` | provenance + StockDB + freshness | data-freshness-monitoring | Thin Q&A over APIs |
| `product-ai-trade-journal-loop` | feed/profile + portfolio journal drafts | portfolio-analysis, feed, profile | Schema design first if missing |

**Rule:** If Enhance column is non-empty, PRD § What must be ENHANCE/FIX first; Out of scope must name the greenfield alternative rejected.

---

## 7. Shared risk floors (every PRD must reference)

| Floor | Rule |
|---|---|
| **R1 Token** | No orchestrator subagents; no always-on mega-memory; skills one-at-a-time |
| **R2 Dual state** | Cursor writes `cursor-state.md` only — never `.agents/context/state.md` |
| **R3 Explain** | One explain API; click-only AI; sessionStorage cache OK; no auto-hover fetch |
| **R4 Scores** | LLM never overrides numeric scores or `buildReasoning` signal line |
| **R5 Lessons** | Max 15 active in `lessons.md`; trader journal ≠ dev lessons |
| **R6 Redis** | No Redis for agent memory (optional shared cache is separate P3 eng task) |
| **R7 MCP** | Default zero new servers; codegraph remains primary |
| **R8 Money** | No auto-trading / auto-execute; human confirmation for money-adjacent AI |
| **R9 Cache/DB** | Product AI reuses existing caches/APIs; no N+1 breakdown storms |
| **R10 Impact gate** | Every PRD includes full **Impact & Risk Analysis** (6 subsections) |

---

## 8. Gap: ENHANCE / NEW / FIX / SKIP

| Gap | Type | Notes |
|---|---|---|
| Cursor missing codegraph precheck / wrap hooks | ENHANCE | Port patterns from Claude |
| alwaysApply rule bloat risk | FIX | Trim / agent-requestable |
| Skills hard to discover in Cursor | ENHANCE | Index in CURSOR.md / skill stubs |
| No slash playbooks for wrap/verify | ENHANCE | Thin command docs |
| MCP sprawl temptation | SKIP default | Document do-not-add |
| AGENTS.md not linked from Cursor entry | ENHANCE | Pointer |
| Verifier not in Cursor habit | ENHANCE | Playbook after features |
| Lesson ↔ Claude memory drift | ENHANCE | Hygiene policy |
| state.md write leaks | FIX | Safety isolation |
| Explain not on CSP cards consistently | ENHANCE | Wire existing API |
| DQ = tables only, no ask | ENHANCE | Chat over provenance |
| Closed trades don’t feed learning | ENHANCE | Journal tags + retrieve |
| Multi-model orchestrator | **SKIP** | Token antithetical |
| Fine-tune / vector mega-memory | **SKIP** | Explicit memory only |
| Second explain API | **SKIP** | Extend payload types later on same route |
| Auto-trading agent | **SKIP** | Hard ban |

---

## 9. Explicit do-not-build list

- Perplexity-style multi-model orchestrator
- Fine-tuning as “learning”
- Vector mega-memory always loaded
- Auto-trading / auto-execute agent
- Second explain API or parallel Haiku pipeline for scores
- Redis agent state
- 8-agent fan-out / orchestrator subagents
- Global free-form chatbot with full DB dump
- Replacing `buildReasoning` or fund/tech scorers with LLM

---

## 10. Recommended build order (agentic + product AI)

1. `agentic-safety-context-isolation` + `agentic-lesson-memory-hygiene` (floors)
2. `agentic-scoped-rules-trim` + `agentic-mcp-selective` (cost/leak)
3. `agentic-cursor-hooks-parity` + `agentic-verifier-gate`
4. `agentic-skills-discovery` + `agentic-commands-playbooks` + `agentic-agents-md-bridge`
5. `product-ai-explain-csp` (after/with contextual-score-explanations)
6. `product-ai-data-quality-chat` (after/with data-freshness)
7. `product-ai-trade-journal-loop` (after portfolio-analysis journal design)

---

## 11. PRD quality gate

Reject any agentic/product-AI PRD that lacks **Impact & Risk Analysis** with:

1. Blast radius / impact  
2. Bug introductions  
3. Performance & cost  
4. Workflow changes  
5. Drift & consistency  
6. Scalability  

Each subsection ≥2 concrete bullets; ≥1 explicit “do not”; name paired systems for drift; cite shared floors R1–R10.

---

## Review (2026-07-09) — task-reviewer

**Verdict:** RESCOPE (as a living **reference**, not a build task) — content **Keep**; task framing **Cut/Archive** after extract

**Lenses:** PM Keep (floors) | UX N/A (dev+policy) | Eng Keep (inventories match code) | BA Rescope (done ≠ sprint item) | User N/A directly

**Why pitched:** User asked for agentic audit + groundbreaking-AI research *before* PRDs so we wouldn’t gold-plate chat/orchestrators.

**Need:** Yes for **R1–R10 + SKIP + enhance matrix**. Without them, `ai/2–13` drift. Narrative Category A–E is optional once floors exist.

**Code reality:** Confirmed — `POST /api/explain/score`, `buildReasoning`, Cursor hooks = sessionStart only, provenance admin path. Inventories are not fiction.

**Nits / rescope:**
1. Status `done` but still seq `#1` “Blocks all” — reframe as **REFERENCE**; archive or rename `0-` / move to `ai/REFERENCE.md`; unstick “implement research”
2. Extract **§7 floors + §9 SKIP** into a short always-cited stub (~40 lines) so reviewers don’t reread 220 lines
3. Creative-apps tables: cite “as of 2026-07-09”; don’t re-research unless strategy changes
4. No acceptance criteria / Impact & Risk on this file — OK for research **if** tagged reference; bad if treated as open work

**Bugs if treated as unfinished work:** Agents re-run web research every session (token waste); PRDs ignore floors because doc feels “historical”

**Better (how others do this):** ADR / RFC / design-doc closed Discovery ticket — durable decisions live; deep brief archives. Not a forever backlog row.

**PRD edits:** Optional extract floors stub; INDEX mark `#1` as reference/archived; proceed reviews on `ai/2+` against floors.
