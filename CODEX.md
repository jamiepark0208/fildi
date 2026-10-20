# FILDI — Codex adapter
Read root `AGENTS.md` first. Shared policy stays there.

## Prompt intake
- Caveman replies: answer first, short plain bullets; no code unless asked.
- Silently extract goal, ALL tasks, constraints, exceptions, approvals, and done-when checks from messy prompts. Preserve intent; never another model just to summarize. Respect one-step-at-a-time requests.
- Load only the relevant topic from `.agents/context/INDEX.md` and one matching existing task skill from `CLAUDE.md`'s skill table. Do not load that entire adapter for routine work.

## Code and tools
- Use `.agents/skills/fildi-workflow/SKILL.md` for FILDI code investigation, implementation, debugging, and research.
- CodeGraph 1.0.0 works at `/usr/local/bin/codegraph`. Actual MCP tools: `codegraph_search`, `codegraph_callers`, `codegraph_node`, `codegraph_explore`. Older docs mention `codegraph_context`; it is absent. Use actual schemas.
- Check graph status; sync after relevant source edits or suspected drift. Confirm important matches against current source. CLI works immediately; new MCP connections may require a session reload.
- Research: `scripts/fetch-page.sh` uses existing Crawl4AI, no extra MCP. Read its cached Markdown selectively. Deep crawl only for a concrete need; save sources only when cited by a study/ASKS row. Sandbox cache override: `CRAWL4_AI_BASE_DIRECTORY=/tmp/fildi-codex-crawl`. Chromium launch may still be blocked: report it, use available browser/web tools, never claim a successful crawl.
- OpenJev: `FILDI_AGENT=codex python3 scripts/oj.py ...`; follow `.agents/openjev/README.md` and registry tiers. Session start: `pending`; verify if work exists. Before broad file reads, large diagnostics, studies, duplicate checks, or skill selection, use the existing helper. Below A = shortlist to check, not an exclusion gate. Exit 3 = proceed directly. Reuse the shared server; never launch a second model instance.
- GitHub: authenticated `gh`; local Git for code/history. Root sync-script rules apply. Setup does not authorize unrelated commits, pushes, queue work, or messages.

## Effort recommendations
Keep the user's selected model. These are workload recommendations, not automatic switching or proven cost rankings. Project default is medium for future sessions; chat settings may override it.
- Low: exact lookups, docs/config changes, mechanical edits with a clear check.
- Medium: routine features, bounded debugging, multi-file implementation.
- High: architecture, subtle concurrency/data correctness, scorer/backtest reviews, persistent unexplained failures.
Raise effort when evidence warrants it. Do not claim an effort/model switch unless a supported control actually changed it.

## Context and coordination
- Targeted symbols and source ranges; bounded output. Retain full diagnostics in temporary files when necessary. Never blanket-read archives, lockfiles, or generated code.
- Codex notes only: `.agents/context/codex-state.md`. Keep goal, constraints, path ownership, branch/SHA/date, decisions, checks, blockers, next action. No raw logs or copied source. Recheck live status/source before trusting old notes or index lines.
- Same task: keep continuity. Unrelated task: fresh context. No invented context thresholds or token-saving percentages.
- Work inline by default. Delegate only on explicit request or applicable instruction, using a short self-contained task and bounded return. No full-history exploration fan-out or prompt-cleanup agent.
- Respect shared dirty-tree ownership and existing roles. No competing orchestrator, memory, research, or sync system. Follow the root ship checks.
