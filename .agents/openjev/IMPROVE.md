# OpenJev pattern improvement loop — train, don't quit

When an eval shows misses, the move is to **improve the pattern**, not abandon the use case.
Miss → analyze → fix the prompt → re-eval → measure. Each cycle is cheap (one `oj.py eval`).

## 1. Analyze the misses

Pull the eval items + answers. For each miss (wrong answer with high confidence), ask:
- **Label noise?** The ground truth comes from git history ("file was in the commit"). Commits include incidental drive-bys. If the file change looks unrelated to the task, flag it as suspected noise — don't train on it.
- **Real miss?** The model should have gotten it. These are training signal.

Example (P10, 2026-10-18): 4 high-confidence misses at P<0.1. Two were label noise
(`edgar-client.ts` in an options-scanner commit, `option_derive.py` in a row-restore commit).
Two were real: model didn't connect "Model List badge" → `model-thesis-report.tsx`,
or "P(OTM) chip" → `watchlist.ts`.

## 2. Fix the prompt (not the weights)

The model is frozen. "Training" = in-context learning:
- **Few-shot from real misses:** add 2–3 examples of non-obvious YES/NO to the question.
  Use only clear cases, never the noisy ones. Never train on the eval's own test items
  and re-eval on the same items — new `oj.py eval` samples fresh commits.
- **Domain bridging:** if misses share a pattern ("UI task → shared component"),
  add one instruction line naming the pattern.
- **Decomposition:** if one question is too broad, split into two (e.g. "what domains
  does the task touch?" then "does this file serve one of those domains?").

## 3. Version it

Edits to a measured question = new version id (`P10v2`), tier C. Old row keeps its
measurement as history. Only mark `superseded_by` after the new version measures better.
`oj.py eval P10v2` → compare lower bounds, not point estimates.

## 4. What NOT to do

- Don't train on label noise — you'll teach the model the eval's bugs.
- Don't promote to tier A on verify alone — verify checks reproducibility, not safety.
  Ask: what happens when this gate is wrong? (P10: skipping a needed file.)
- Don't fine-tune weights for a prompt problem — prompt fixes are 100× cheaper.

## 5. Finding new questions

Misses reveal what the model CAN'T do yet. Each systematic miss pattern is a candidate
for a new decomposed question. If P10 keeps missing UI-component links, that's not
just a P10v2 fix — it's a signal for a new pattern ("which UI components does this
task touch?").
