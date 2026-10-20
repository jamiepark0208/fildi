---
name: fildi-workflow
description: Navigate and assess FILDI using its existing code index, domain evidence, and workflow rules. Use for FILDI repository work.
---

# FILDI retrieval
Clone: `/Users/jamiepark/Cursor/fildi`. Apply root `AGENTS.md` and `CODEX.md` once; revisit only changed/relevant guidance.

- Start from the decision/question and success check. Topic router: `.agents/context/INDEX.md`. Assessment and selected entrypoints: `codex-assessment.md` and `codex-context-map.md` alongside it. Read linked detail only when useful.
- CodeGraph CLI: `codegraph status`; `codegraph query "symbol" --limit 5`; `codegraph node "symbol"`; callers/impact for shared logic. File map: `codegraph node "basename" --file "relative/path" --symbols-only`. Installed 1.0.0 lacks the older `codegraph_context` command/tool. No MCP required.
- Confirm critical paths, timestamps, callers, and lines with targeted `rg` and source ranges; graph coverage is partial. Avoid whole-file reads, archives, dependency trees, and raw data dumps. Sync only when relevant indexing drift/source edits warrant it.
- Financial evidence: `research/studies/INDEX.md` routes prior studies; `METHODS.md` and `PLAYBOOK.md` define local evidence standards. Judge each factor on its intended decision. Treat recorded claims as claims until checked against the report/method/code.
- Existing task skills: find the matching row in `CLAUDE.md`'s skill table; load only that skill. Do not execute its tool-specific startup duties.
- Existing Crawl4AI and OpenJev may help when available within authorized access. Do not start models or expand permissions to use them. Below-tier-A helper answers are shortlists, not exclusion gates.
- Run only relevant checks with understood side effects. Report evidence, checks actually performed, and unknowns. Keep Codex notes separate; no assumed authority to update queues or other agents' state.

- Compact checks and shared handoffs: `.agents/context/efficiency-playbook.md` → “Explicit development checks”. Use existing `oj.py run --local` for deterministic output/receipts; existing ASKS template for packets. Read that section only when running or handing off checks. No automatic test skipping or new hooks.
