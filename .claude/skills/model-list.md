---
name: model-list
description: Load before changing Model List, fit params, watchlist_sync scoring, or what the desk shows as trade picks. Thin router — prevents wrong-file edits and unapproved score changes.
---

# Model List / watchlist_sync

## When
Scoring, folders, verdicts, fit version, daily/intraday publish, or UI that shows Model List picks.

## Homes (one place each — don’t invent a second)
| Concern | Path |
|---|---|
| Plan + steps | `scripts/watchlist_sync/PLAN.md` |
| Factor ownership | `scripts/watchlist_sync/FACTOR_MAP.md` |
| Fit params / versions | `scripts/watchlist_sync/params.py` (champion string) |
| Daily build | `scripts/watchlist_sync/daily.py` |
| Trader thesis | `.claude/skills/trader-context.md` |
| Prior evidence | `research/studies/INDEX.md` then `PLAYBOOK.md` |
| Put strike (Δ target, re-strike, income floor) | `rules.py` PUT_* + `build_plan.restrike_puts` — 0.09Δ since 10-24 (S088-vs-ML, A250); L2 floor scales in `verify_plan` |

## Hard rules (token savers)
1. **Scoring/selection change** → Jamie approval + before/after. Jamie asking for the task **is** approval (AGENTS.md §7) — still show before/after; don’t re-ask.
2. **Model tags ≠** `watchlist.color_tag` — never write RH list colors from the model.
3. **Check INDEX** before a new factor/study — don’t re-run answered questions.
4. **UI/API TS** under `artifacts/{api-server,stock-compare}/src/**` → `scripts/agent-ship-check.sh` before push.
5. **Git bus** → `scripts/agent-git-sync.sh` only (no stash/rebase/hand pull).

## Out of scope here
- RSI/MFI scanner tiers → `signal-filters.md` + `api-server/src/lib/constants.ts` (separate, not Model List)
- Fund V2 scorecard internals → own Cursor lane / `technical-scorecard` / fund-score-engine
