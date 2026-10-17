# OpenJev for agents — save tokens with typed answers (all agents; Jamie 10-17)

**What:** a local model on Jamie's Mac (DiffusionGemma 26B via OpenJev, $0, no data leaves the Mac). You give it text + a typed
question; it returns a **probability distribution** over the options in ~0.2–1 s. It reads the long text, you read only the answer
→ the text never enters your context. Evidence: S037–S039 (`research/studies/INDEX.md`). Live list: **[REGISTRY.md](REGISTRY.md)**.

## 1. When to use it (and when never)
- **Use:** sort an item into categories *we* define — is this file relevant, is this output a failure, which group/skill/tool,
  is this the same need as row X, is this headline a roundup. High volume, cheap, a wrong answer is caught later.
- **Never:** predict prices or outcomes (R01, R04, R06), or judge a number you show it (fair value, PT, weights: **it copies the
  number**, R02 placebo). Never final authority on scores (AGENTS rule 7). Never trades.
- Check the pattern's tier in REGISTRY.md first:
  **A** proven → may gate work (skip reading, skip a step) · **B** promising → hint only, verify yourself · **C** untested → run
  `oj.py eval` before relying · **X** rejected → don't ask it. Unregistered question → treat as C.

## 2. How to call
```
echo "<text>" | scripts/oj.py ask --q "<question>" [--type noul|choice|score] [--options '<json>'] [--pattern P10]
```
- Prints JSON: `noul` = P(yes); `choice` + `probabilities` + `confidence`; `score` = expected level + `probabilities`; `usage_id`.
- Exit 3 / `{"available": false}` = not enough free RAM (needs ~26 GB) or no Mac → **decide yourself; never block on OpenJev.**
- Dev server starts on demand (~15 s), stops after 10 idle min (`oj.py stop` to free RAM now). Set `FILDI_AGENT=<you>`.
- If you later checked the answer anyway: `scripts/oj.py outcome <usage_id> yes|no` (this is what keeps patterns honest).
- Privacy: never send holdings, quantities, cost basis, account values, P&L, transactions, `.env`/keys.
- Who can call: Claude, Cursor, Muse (Mac access), Kiro (on the Mac). Grok / cloud agents: no Mac → read the registry,
  propose patterns as C; cannot measure or verify.

## 3. It is probabilistic, not just yes/no
Every answer is a full distribution read from the model's own probabilities (no text, can't go off-schema):
`noul` = P(yes) · `choice` = P over up to 255 options · `score` = P over ordered levels (2–10). Heavier analysis =
**decompose**: many small typed questions, combine the probabilities in code (sum over scenario branches, Bayes, weighted
scores). Rules: (1) raw probabilities are overconfident → **calibrate on our labels before showing a %** (S039: Brier
0.063 → 0.040); (2) it cannot output a number — give it bins/options; (3) shuffle option order and average 2 reads for
choices (position bias, A129); (4) `think` (reasoning first) ≈ 25× slower — hard cases only; (5) a distribution is only
as good as its graded track record → that is what the registry holds.

## 4. Good vs bad — defined per use (the `rule` in registry.json)
| Use (`rule.kind`) | Good = | Why |
|---|---|---|
| `gate_keep` (skip work when P < threshold) | ≥ 95 % of truly needed items kept (Wilson 90 % lower bound) + report skip rate | a wrong skip costs rework |
| `accuracy` (label / route) | lower bound ≥ target and beats the cheap baseline (rule, regex, majority) | must earn its place over a rule |
| `ic` / `auc` (rank, flag) | lower bound ≥ target on a time split | ranking quality, no peeking |
| `brier_gain` / `placebo` (probabilities, numbers) | beats the reference Brier; ignores a fake number | honest % only |
**Tier A** = lower bound ≥ target AND re-verified by a second agent. **X** = upper bound < target. Otherwise **B** (measured) or **C**.
Confidence is never typed: it is the computed Wilson/CI bound on `n` labelled items.

## 5. Accountability (what if an agent is wrong or hallucinates an entry?)
1. **Numbers only from scripts.** `oj.py eval <id>` builds the labelled set (deterministic builder in `scripts/oj_evals.py`),
   asks OpenJev, scores it, stores items + answers + their hashes. Hand-typed numbers have no hash → stay tier ≤ B.
   Study-cited entries (pre-framework) stay ≤ B until re-measured this way.
2. **Two keys.** `oj.py verify <id>` by a *different* agent: hashes must match, metrics are recomputed from the stored
   answers, and 20 % of items are re-asked live (≥ 90 % must agree). Only then tier A. Author can't verify own entry.
3. **Live track record.** `oj.py outcome` logs whether answers held up in real use; `oj.py audit` computes live accuracy and
   **auto-demotes** a pattern whose live upper bound falls below target (≥ 20 outcomes).
4. **Re-verify triggers:** model/weights change, 60 days since `verified_at`, a demotion, or a disputed entry.
5. **Disputes:** any agent may run `verify` or `eval --build` at any time; mismatch = automatic loss of verification + ASKS row.
6. **Adding a pattern:** anyone may add a **C** row (question, use, rule, label source, baseline) to `registry.json`, then
   `oj.py render`. Label source must be real outcomes or history, or say "Claude-labelled" (weaker, flagged). Promotion
   only via eval + verify. Commit with `Refs: A150`.

## 6. Token-saving playbook (dev patterns; tiers live in REGISTRY.md)
P10 file relevance before reading · P11 failures in long command/test/log output · P12 does a diff touch quant (review gate) ·
P13 ASKS/inbox duplicate · P14 does a study already answer this · P15 which skill/context file · P16 does this need Jamie ·
P17 commit message vs diff · P18 doc drift after an edit · P19 Explain AI routing. Use only at tier A as a gate; at B/C as a hint.

Owner: Claude (PM) keeps the registry honest (session start: `oj.py audit`; re-verify on triggers). Jamie decides gates that change scores.
