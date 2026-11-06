# Reviewing a study — guide for any reviewing agent (Codex, Grok, Muse, Claude)
> Jamie 10-20: "I'm skeptical of the Research tab; Codex reviews Claude's results, finds ways to enhance them, gives feedback."
> Goal: find what's wrong **and** what would make the answer more useful. Skeptic ≠ correct: every finding cites evidence and carries a fix.

## What you get per study (the packet)
| Item | Where |
|---|---|
| One-line answer + status | `INDEX.md` row |
| Card: question, data, method, result table, verdict, decision, **known weaknesses** | `Sxxx-<slug>.md` (start with Known weaknesses) |
| Pre-registration (bar set before data) + amendments | `PLAN-*.md` or the INDEX "Next studies" row; amendments are labelled vN.x |
| Script that reproduces every number | `scripts/watchlist_sync/analysis/<script>.py` (docstring = run command) |
| Full report | `scripts/watchlist_sync/out/<area>/<study>.md` (versioned) |
| Trade-level output | `out/…/*.json` (local, gitignored — re-run to create) |

## Review checklist (in this order — the order costs least first)
0. **Auto-revise** a packet whose verdict is "nothing works / all lose" without comparator + mirror + best cell (PLAYBOOK § 4b). Jamie 11-06.
1. **Right question?** Does the target match the trader's decision (METHODS 1b), and are the comparators what he'd do instead (incl. a same-risk version)?
2. **Reproduce** one headline number from the script, not the card.
3. **Look-ahead:** every input known at entry (point-in-time joins, `≤ as_of`, earnings timing per `CONVENTIONS.md`)?
4. **Cash flows:** fills (bid + 23 % of spread), T-bill on idle cash, splits, assignment handling.
5. **Mechanics/placebo:** could the result come from IV or distance by construction (METHODS 2–3)?
6. **Inference:** clustering/overlap handled (expiry weeks, overlapping holds → block bootstrap), multiple testing (Holm), both halves + holdout.
7. **Amendments after seeing data:** labelled? Do they change the verdict?
8. **Wording:** is the benefit stated plainly and separately from the pass bar (skill `fildi-quant-research` §1.5)? Overclaiming or underclaiming are both findings.
9. **Enhancements:** the cheapest next test that would change the decision; a use not tested (METHODS 1b).

## How to file
Append to the study's ASKS file (`research/common/asks/A##.md` § Reviews) as `**<Agent> review <study> <date>:**` with numbered findings:
`claim / evidence (path:line, number, re-run output) / fix / severity (changes verdict | changes size | cosmetic)`.
Claude answers each: accept → fix + re-run + card updated, or rebut with evidence. Do not edit the study files yourself.

## Open for review now
| Study | Card | Ask |
|---|---|---|
| S064 buy-zone puts | `S064-buy-zone-puts.md` | A212 |
| S066 earnings block (interim) | `S066-earnings-puts.md` | A212 |
| S049-crash re-audit | `S049-crash-reaudit.md` | A212 |
| S152 indicator option structures (0/228) | `S152-indicator-option-structures.md` | A334 |
| S153 swing reverse-engineer | `S153-swing-reverse-engineer.md` | A335 |
| S154 signal-state playbook (quiet → long strangle, shadow) | `S154-signal-state-playbook.md` | A336 |
