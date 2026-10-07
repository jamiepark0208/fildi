# Research studies — how to work

One catalog (`INDEX.md`), one set of method rules (`METHODS.md`), one report per study. Goal: never redo a study, always find the answer
in under a minute.

## Before
1. Search `INDEX.md` (catalog + topic lookup) and `scripts/watchlist_sync/FACTOR_MAP.md`. If it's answered, cite it; if a re-test is
   due, re-run its script instead of writing a new one.
2. Claim an ID: add a row to "Next studies" (or the catalog with status **open**) with the question, data and stop rule.

## During
- Script: `scripts/watchlist_sync/analysis/<name>.py` (Model List / trading) or `research/<area>/` (vendor-specific: WRDS, LSEG,
  fair value). Read-only on live tables. Header docstring = question, method, how to run.
- Output: `out/<name>/report.md` (versioned). Caches and data stay local (gitignored).
- Follow `METHODS.md`.

## After
- Add / update the catalog row (one-line answer, status, links) and the topic lookup.
- Write a card `Sxxx-<slug>.md` only when the report doesn't already explain the conclusion (template below). Keep it ≤ 60 lines.
- Decisions and next steps → `.agents/context/state.md` (Claude) / `.cursor/context/cursor-state.md` (Cursor). New method lessons →
  `METHODS.md`. Superseded studies keep their row, marked **superseded by Sxxx**.

## Card template
```
# Sxxx — <question>
Date · Status · Script · Report
## Question            one sentence, as asked
## Data                source, period, n, exclusions
## Method              target, baseline, controls (METHODS.md rules applied)
## Result              the table that matters (≤ 15 rows)
## Verdict             one paragraph: what's true, how sure
## Decision            what changed (or didn't) and who approved; before/after if scoring moved
## Caveats / re-test   what would change the answer; when to re-run
```
