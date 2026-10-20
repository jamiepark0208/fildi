---
name: fildi-workflow
description: Investigate, modify, debug, or research FILDI using its existing CodeGraph, Crawl4AI, OpenJev, and shared context rules. Use for FILDI repository tasks, not unrelated coding or general finance questions.
---

# FILDI workflow
Repository: `/Users/jamiepark/Cursor/fildi`. Run repository tools there. Read root `AGENTS.md` and `CODEX.md` if not already loaded; keep policy there.

## Find code cheaply
1. Define the concrete task and acceptance check. Load only relevant domain context.
2. Check `codegraph status`. Prefer connected MCP search/node/callers with actual schemas and small limits. Installed 1.0.0 has no `codegraph_context` tool.
3. CLI fallback: `codegraph query "symbol"`, `codegraph node "symbol"`, `codegraph callers "symbol"`, `codegraph impact "symbol"`. File map without bodies: `codegraph node "relative/path" --file --symbols-only`. Broader `explore` includes source: bound `--max-files` and output.
4. For missing/stale index results, use targeted `rg`, then narrow source ranges. Confirm current lines before editing. Current reference packs can go straight to targeted checks.
5. Check impact/callers for shared changes. Sync after source edits; actual behavior/tests decide success.

## Research and local helpers
- Full-page research: existing `scripts/fetch-page.sh <url>` prints the temporary Markdown path. Search before reading it. See `CODEX.md` for sandbox/cache behavior. Prefer primary technical sources.
- Existing `scripts/oj.py` helpers shortlist files, summarize diagnostics, find studies/duplicates, or select skills. Read the relevant pattern's tier in `.agents/openjev/REGISTRY.md` first. Unproven classification cannot exclude potentially relevant evidence.
- Existing task skills: consult the skill table in `CLAUDE.md`, then open only the matching file. Do not copy all skills into the discovery catalog.

## Finish
Run checks relevant to changed behavior, including root ship gates when applicable. Record actual results and failures. Use only Codex session notes. Follow root Git sync and ownership rules; no assumed authority over another agent's queue.
