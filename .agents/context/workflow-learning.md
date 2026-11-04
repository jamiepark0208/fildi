# Workflow learning loop — agent tokens & steps (W-registry)
> Jamie 10-20: every workflow step should earn its place; "if any step did not help development and save tokens, agents fix the
> workflow or at least make suggestions to other agents for proposal review". Same spirit as the studies INDEX and the OpenJev
> registry: a change is a hypothesis with a metric, a target and a review date — measured, not assumed.
> App runtime efficiency (AI calls, Schwab RPM, caches) lives in `efficiency-playbook.md`; this file is the **agents' own** workflow.

## How it works
1. **Register** any workflow change (new startup step, tool, rule, file split) as a W row *before or with* the change: hypothesis,
   metric key, baseline, target, review date (≤ 2 weeks), owner.
2. **Measure**: `python3 scripts/workflow_audit.py` (also step 10 of `scripts/agent_start.py`, every session) computes each metric
   from real data — Claude session logs (per-request usage, same source as Settings › Agents), `~/.fildi/workflow-usage.jsonl`
   (tools log each run), file sizes — and appends a snapshot to `~/.fildi/workflow-metrics.jsonl` (trend).
3. **Decide at the review date** (audit prints FAIL when due and missed):
   - owner's own files → fix it or revert it, update the row (status `kept` / `fixed <date>` / `reverted`);
   - shared files (AGENTS.md, CODEX.md, CURSOR.md, other agents' tools) → file an ASKS **proposal** to the owning agents (review loop);
   - never delete a row: `reverted` / `retired` rows are the record of what didn't work.
4. **Any agent** may add rows for its own workflow; metrics without a measure key are added to `workflow_audit.py` (`measure()`).

## Baseline 2026-10-20 (14 days, 11 Claude sessions; `workflow_audit.py`)
Median session ~47M context tokens sent (this session 106.7M, 459 requests); median **~225k tokens re-sent per request** (the real cost
driver — grows with session length); first-request context ~49k (tools + instructions); instruction files CLAUDE 10.7k / AGENTS 11.9k /
MEMORY 5.2k chars; state.md 25.7k chars (~6.4k tokens) before rotation; failed SQL guesses median 4 / session (this one 34).

## Registry
| ID | Change | Owner | Hypothesis | Metric | Baseline | Target | Review | Status |
|---|---|---|---|---|---|---|---|---|
| W01 | `scripts/agent_start.py` — all startup steps, ≤ 15-line digest, full log to ~/.fildi/logs | claude | raw step output (sync, audit, git log) no longer sits in context for every later turn | `start_chars_saved` median (log − digest chars) | ~0 (steps run one by one) | >= 5000 | 2026-10-27 | active |
| W02 | `scripts/state_rotate.py` — state.md ≤ 12k chars, verbatim archive, pinned ## Standing | claude | state.md stops growing; next-session read ~6k → ~3k tokens; nothing lost (archive + pins) | `state_chars` | 25,700 | <= 12500 | 2026-10-27 | active |
| W03 | Instruction files trim (CLAUDE.md hot-file table → `.claude/skills/hot-files.md`; AGENTS.md dedupe via A210) | claude (AGENTS.md: all, A210) | every request carries them; −30 % = cheaper base context with no rule lost | `instr_chars` (CLAUDE + AGENTS + MEMORY) | 27,790 | < 24000 | 2026-11-03 | active (CLAUDE.md done 10-20: 10.7k → 9.6k) |
| W04 | `scripts/watchlist_sync/rebuild.sh` — quiet plan→verify→publish + funnel | claude | rebuild output ~40 lines → ~6; used instead of 3 verbose commands | `rebuild_uses` (14 d) | 0 | >= 2 | 2026-10-27 | active |
| W05 | `scripts/watchlist_sync/funnel.py` — "why is X (not) on the Model List" in one call | claude | replaces ~12 ad-hoc queries per question | `funnel_uses` (14 d) | 0 | >= 2 | 2026-10-27 | active |
| W06 | `scripts/dbcols.sh` + memory `reference_model-list-db.md` before querying | claude | failed SQL guesses per session fall | `sql_miss_per_session` (median) | 4 | <= 1 | 2026-11-03 | active |
| W07 | One task per session + `/clear` at task boundaries (CLAUDE.md rule, now measured) | claude | context re-sent per request stays smaller | `ctx_per_request` (median of session means) | 225,000 | < 150000 | 2026-11-03 | active |
