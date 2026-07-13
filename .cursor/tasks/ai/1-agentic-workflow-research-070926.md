# agentic-workflow-research

| Field | Value |
|---|---|
| **Status** | done (reference, not a build task) |
| **Priority** | P0 |
| **Area** | research |
| **Created** | 2026-07-09 |
| **Source** | user-request (agentic audit) |
| **Blocks** | All `agentic-*` and `product-ai-*` PRDs |

## Resolution

Research concluded: groundbreaking AI apps win by putting models inside trusted workflows with explainability and feedback loops, not by bolting on chat/multi-model orchestration. Produced an enhance-first matrix (every planned agentic/product-AI PRD must enhance an existing surface, not fork a new one) and ten shared risk floors (R1–R10: no orchestrator subagents, Cursor never writes `.agents/context/state.md`, one explain API with human-click-only triggering, LLM never overrides numeric scores/`buildReasoning`, capped lessons, no Redis for agent memory, default zero new MCP servers, no auto-trading, product AI reuses existing caches/APIs, and every PRD needs a full Impact & Risk Analysis). Explicit do-not-build list: multi-model orchestrator, fine-tuning-as-memory, always-loaded vector mega-memory, auto-execute agents, a second explain API, Redis agent state, and 8-agent fan-out orchestration.

Reviewed 2026-07-09 and rescoped from "sprint item" to living reference — content kept, but flagged for future extraction of just the R1–R10 floors + do-not-build list into a short always-cited stub so downstream PRDs don't need to reread the full research. That extraction was not done as part of this pass; full floor/SKIP detail lives in git history for this file.
