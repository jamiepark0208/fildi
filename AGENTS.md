# TradeDash — shared agent ToC
> Single entry for Cursor, Claude Code, and other coding agents. Thin by design — open linked files on demand.

## Read next
1. **[`.agents/context/INDEX.md`](.agents/context/INDEX.md)** — topic → file map  
2. **[`.agents/context/agentic-floors.md`](.agents/context/agentic-floors.md)** — R1–R10 + do-not-build  
3. **[`.agents/AGENTS.md`](.agents/AGENTS.md)** — subagent routing (verifier / data-agent / ui-agent)
4. **[`research/studies/BOARD.md`](research/studies/BOARD.md)** — works / dead / testing, one line each; read before proposing any test. Detail: **[`research/studies/INDEX.md`](research/studies/INDEX.md)** — every study / backtest and its answer. Check it before any analysis; add a row after. How to run one: [`PLAYBOOK.md`](research/studies/PLAYBOOK.md)
5. **[`.agents/context/jamie-rules.md`](.agents/context/jamie-rules.md)** — Jamie's standing rules for every agent (decisions, verdict wording, no personal trades in rules). Add new ones there; never make him repeat one.
6. **[`.agents/context/recurring-bugs.md`](.agents/context/recurring-bugs.md)** — bug classes that keep coming back (stand-in 0s, two pickers, ticker joins, step order, units). Read before any fix to recs/scores/surfaces; fix the producer, add the case to its row.
7. **Stock notes (Jamie 10-28)** — per-ticker dated facts that took analysis to learn (trades, earnings reactions, levels, backtests, character). **Before** analysing or recommending a ticker: `scripts/stock_notes.py show <T…>`. **After**: add ≤ 2 notes, one fact each, ≤ 280 chars, `--src` study/bug id, `--author <you>` (`stock_notes.py add T <trade|earnings|levels|backtest|character|lesson> "…"`). Notes are history, never a forecast. Shown in Breakdown › Notes and fed to the AI explain prompts.

**Jamie's verify path (A381, 3 surfaces only):** BOARD / Strategies (what works, live vs claim per A380) · Ideas tab (the queue) · this file. Anything else is agent detail.

## Skills
`.claude/skills/<name>.md` — load **one** at a time (see CLAUDE.md / CURSOR.md tables).
**Shared financial skills (every agent, Jamie 10-20):** `.agents/skills/fildi-quant-research` (studies, backtests, scenarios — the judgment rules) · `fildi-market-data` (sources, budgets) · `fildi-market-thesis` (test a market view: claim tree, analogs, money flows, scenarios, scored) · `fildi-grade-quality` (is a score/rec working) · `fildi-pattern-research` (indicators as context: forward turning-point labels, lift tiers, confluence + combined model — Jamie 10-29) · `fildi-briefs-dig` (Jamie's tradedash-brief emails → typed facts → verify vs our data → so-what → graded claims; plan `research/common/briefs-dig-plan-2026-10-30.md` — Jamie 10-30). Study reviews: `research/studies/REVIEW.md`.
**Shared-file safety (10-20 incident):** edit shared tables with the Edit tool or `scripts/md_rows.py`; never `open(p,'w')` in an expression that reads `p`. `.agents/hooks/shield.mjs restore <path>` undoes a truncation.

## Tool adapters (do not duplicate policy into these)
| Tool | File |
|---|---|
| Claude Code | [`CLAUDE.md`](CLAUDE.md) |
| Codex / ChatGPT coding | [`CODEX.md`](CODEX.md) — session startup and compact context |
| Cursor | [`CURSOR.md`](CURSOR.md) + `.cursor/rules/` |
| Muse AI (live remote) | [`MUSE.md`](MUSE.md) — git bus `cursor/mac-dev`; ASKS handoffs **to Cursor only** |
| Grok Bot (devil’s advocate) | [`GROK.md`](GROK.md). Rules: [Grok Bot plan review](#grok-bot-plan-review-jamie-2026-10-17). |

**Codex/Astra session start:** read `CODEX.md` and `.agents/context/codex-state.md` once. Restore the saved goal/constraints; follow the current user request. “Continue” means resume the checkpoint's next action. No pasted kickoff prompt required. Do not adopt other agents' duties or start work merely because a terminal opened.

## One team (Jamie 10-05)
Claude, Cursor, Muse (live remote; bus = git `cursor/mac-dev` + ASKS) share the repo. Cursor owns all `Muse → Cursor` rows; Claude plan-reviews them, never implements them.
1. **Never make Jamie relay.** ASKS is the log; it never blocks finishing work.
2. **Sync only with `scripts/agent-git-sync.sh`.** Shared dirty tree: never `stash`, `rebase`, `pull`, `checkout`/`reset`/`restore` others' files. Commit only your paths, then run it. Exit 2 = real conflict → you fix it, never Jamie. New clone: `scripts/agent-git-setup.sh`.
3. **Queues:** `Muse → Cursor` = Cursor's; `Claude/Cursor → Claude` = Claude's.
4. **Check before editing:** `git status`/`git diff`; build on others' work. Before SQL: `scripts/dbcols.sh <table> [col]`.
4a. **New quant ideas (11-07):** a new `[quant]` idea carries a fast_screen line (gross / net at real fill / n) in its file before it becomes a row. No row-count cap (Jamie 11-12: removed). Parked/declined rows carry `**Revisit-when:**` (agent_start 6g flips them back). Quant dispatches auto-append `.agents/dispatch/_study-contract.md`.
4b. **Check before filing:** `ASKS.md`, `research/studies/INDEX.md`, `oj.py dupes "<idea>"`; extend, don't twin. New `asks/A###.md` needs a `**Dupe check:**` line + fresh id (`scripts/asks-check.sh` blocks the push; also blocks retitling others' rows). Session start: `python3 scripts/agent_start.py --agent <you>`; step 6b = rows untouched > 3 d → owner acts or re-routes.
4c. **Store what you fetch:** whole vendor responses in `vendor_raw` (A266); map fields via FIELD_DEFS or say why not in `research/common/data-inventory.md`. Check that inventory before saying "fully integrated".
5. **One home per piece of logic** (`scripts/watchlist_sync/FACTOR_MAP.md`).
6. State files per tool: Claude `.agents/context/state.md`, Cursor `.cursor/context/cursor-state.md`, Muse = ASKS only.
7. Scoring/selection changes need a logic check + measured before/after, then **the agent decides** (Jamie 11-06; no approval ask). **Jamie asking for the task IS the approval** — finish end to end incl. promotion, show before/after.
8. **Before coding:** state assumptions, write the success check first, loop until it passes. Every changed line traces to the request; match local style.
8b. **Ship gate:** changes under `artifacts/api-server/src/**` or `artifacts/stock-compare/src/**` pass `scripts/agent-ship-check.sh` (enforced on push; a bad import once took down the live API).
8c. **Runtime-safe:** anything that fetches/caches/polls/runs in background: deadline on every vendor call; serve stored value + refresh behind; cap fan-out vs the vendor rate limit; poll interval > server TTL; ship with a measured before/after (ms, calls/min). Fetch the tail from the watermark; backfill only with `--backfill`; use `fetch_guard` / `fetch-guard.ts`. `scripts/perf-guards.sh` flags risky lines on push (advisory); a tripped `perf-watch` signal (agent_start 5c) = fix now.
9. **Reply style = caveman, all agents:** answer first; terse; keep numbers/caveats/failures; ≤ ~15 bullets; no code in chat; name rows by what they do.
10. **Web research = `scripts/fetch-page.sh <url> [--deep N] [--save]`** (local, $0); built-in fetch only for quick lookups; `--save` only when a row cites it. Muse (Mac file access) runs it itself.

## Review loop (Jamie 10-11)
Muse plans → Claude plan-reviews **every** Muse row (quant rows get the eval) → Cursor builds → Muse + Claude review the commit independently → Cursor fixes → verified. Muse also skeptically verifies non-quant plans incl. its own (improve, not just kill); a plan needs use cases + expected results + pass/fail check. Reviewing **another** agent's plan pushes it to the next phase; self-review never does. Grok: see below.
**Quant row** = touches scores, what the Model List / trades show, option pricing, backtests, market-data pipelines. Non-quant rows get a Claude plan review (overlap, PM impact, cheaper path); commit review is quant-only.
**ASKS:** `research/common/ASKS.md` = one-line index (id · date · from → to · title · status); everything else in `research/common/asks/A##.md` (template `_TEMPLATE.md`). Open a file only to act on it. Closed rows → `ASKS-archive.md`.
1. Muse files `Muse → Cursor` (quant titles start `[quant]`). **Every row carries `Moves:`** — the scoreboard number (A171) or `ops`; plan review sends back rows without one.
2. **Claude plan review:** overlap vs code + studies INDEX, adds the eval (tests / pre-registered study with stop rule / before-after), appends `**Claude plan <date>:**` under `## Reviews`, status `planned`. Cursor builds only `planned` rows, **one at a time** (next starts after the previous commit's Claude review passes), P1 data correctness first.
3. Cursor commits carry `Refs: A##`.
4. **Commit review, independent:** Muse = bugs/ops/UX; Claude = quant diffs (look-ahead, units, eval vs acceptance), written **before** reading Muse's verdict. Append `**Muse/Claude review <sha>:**` = `pass` or numbered findings (claim / evidence / fix).
5. Cursor fixes → `done`; both reviews pass on the fix SHA (Muse only for non-quant) → `verified` → archive.
Statuses: `open → planned → accepted → done → verified | declined`. Every commit carries trailer `Agent: claude|cursor|muse|grokbot|codex`.
**Decline check:** every decline/park states (1) **Need** in Jamie's words, (2) **Met by / fails because** (feature, row, or study number), (3) **Revisit trigger**. Decline the method, rarely the need; one rebuttal → re-review; re-audit when the cited study changes. Claude's `Last reviewed SHA:` lives in state.md; review `git log <sha>..HEAD` at session start.

## Grok Bot plan review (Jamie 2026-10-17)
[`GROK.md`](GROK.md) (role approved A142, 10-18). Review-only devil's advocate, **not an implementer**; may edit workflow docs (GROK.md, ASKS routing, adapter notes). ASKS `→ Grok` / `Grok → …`.
- Findings are hypotheses: **skeptic ≠ correct**. Accept or rebut with evidence; never block on vibes, never ignore a finding citing path/study/SHA.
- May red-team a plan after Claude's plan review, before Cursor builds (subjective / high-bias rows; A141).
- Primary reviewer for non-quant plans (esp. Muse-authored); every kill carries a fix. Claude keeps [quant]; non-quant = Claude spot-checks. Reviewing another agent's plan pushes it to the next phase; self-review never does.

## OpenJev — cheap typed answers (Jamie 10-17)
Local model, $0: it reads long text, you read a probability. Check the pattern tier first in [`.agents/openjev/REGISTRY.md`](.agents/openjev/REGISTRY.md) (A may gate · B hint · C untested · X never). Exit 3 = unavailable → decide yourself. Never for price forecasts or judging a number.
**Use points:** > 3 candidate files → `scripts/oj.py files --task "…"`; long output → `oj.py run -- <cmd>`; before analysis → `oj.py studies "<q>"`; before filing → `oj.py dupes "<idea>"`; which skill → `oj.py skill "<task>"`. Below tier A = shortlist, not a reason to skip.
**Session start:** `oj.py pending` → run one listed `verify` (never your own). Registry numbers only via `oj.py eval`; tier A needs a second agent's verify. Rules: [`.agents/openjev/README.md`](.agents/openjev/README.md).
**Learn ritual (A209):** `bash scripts/agent-learn.sh [agent]` → top 3 waste turns; `python3 scripts/session_bloat.py` → which tool output fills context. Demote bad habits via rules/skills with evidence.

## Do not load unless the task needs them
`.cursor/tasks/**` · `.claude/docs/phase-report*` · `.cursor/plans/archive/**`

## Codex integration (Jamie 2026-10-19; A205)
Codex assesses, plans, implements and verifies claimed work using existing ASKS/Ideas and expiring claims. See CODEX.md. Independent review remains required for verified status; Codex does not acquire Claude’s or Cursor’s queues. Activity hooks report metadata only. UI presence does not grant runtime permissions or authorize trading/spend.
