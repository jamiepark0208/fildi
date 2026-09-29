# Agentic floors (Cursor + Claude) — short SoT
> Extracted from `.cursor/tasks/ai/1` research. Read **this**, not the full July PRD.

## Goals
1. Ship TradeDash correctly (peers, fundamentals, scores, maintain)
2. Cheap agents — small always-on context; skills/plans on demand
3. Cursor never writes `.agents/context/state.md`

## Floors (do not violate)
| ID | Floor |
|---|---|
| R1 | ≤3 Cursor `alwaysApply` rules; no CLAUDE.md dump into rules |
| R2 | Cursor never writes `.agents/context/state.md` |
| R3 | No multi-model orchestrator / 8-agent fan-out |
| R4 | Product AI enhances existing surfaces — no forked explain APIs |
| R5 | Lessons capped (15), greppable; ≠ trader journal / P&L |
| R6 | No Redis/vector mega-memory for agent state |
| R7 | Default: no new MCP servers without clear need |
| R8 | LLM never overrides numeric scores / `buildReasoning` |
| R9 | No auto-trading / auto-execute agents |
| R10 | Reuse existing caches/APIs; one skill at a time |

## Do not build
Multi-model orchestrator · fine-tune-as-memory · always-loaded vector memory · auto-execute agents · second explain API · Redis agent state · porting Claude PreToolUse hooks into Cursor for symmetry

Adapters / retrieval: root `AGENTS.md` + `.agents/context/INDEX.md` (do not duplicate here).
