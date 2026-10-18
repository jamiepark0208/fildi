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
- **One shared model for everyone** (`scripts/oj_server.py`): port 8091, a start lock so only the first caller loads it (~15 s)
  while others wait, the server queues concurrent requests itself (busy → automatic retry), and one idle timer stops it 10 min
  after anyone's last request. The 05:30 batch and studies join the same instance. Never start your own server. Caller is
  auto-detected (or `FILDI_AGENT=<you>`); `oj.py stop` frees RAM now.
- If you later checked the answer anyway: `scripts/oj.py outcome <usage_id> yes|no` (this is what keeps patterns honest).
- Privacy: never send holdings, quantities, cost basis, account values, P&L, transactions, `.env`/keys.
- Who can call: Claude, Cursor, Muse (Mac access), Kiro (on the Mac). Grok / cloud agents: no Mac → read the registry,
  propose patterns as C; cannot measure or verify.

## 3. It is probabilistic, not just yes/no
Every answer is a full distribution read from the model's own probabilities (no text, can't go off-schema):
`noul` = P(yes) · `choice` = P over up to 255 options · `score` = P over ordered levels (2–10). Heavier analysis =
**decompose** with `scripts/oj.py analyze --spec .agents/openjev/specs/<id>.json`: several typed questions per item →
features → combination **learned from real outcomes** (fit on earlier dates, graded on later ones) → calibrated P + weights
("why"). Never hand-set weights. First spec P21 (overnight news → P(put name falls > 1σ)): AUC 0.60, calibrated, but no
better than its best single question — decomposition earns its place only when it beats that. Rules: (1) raw probabilities are overconfident → **calibrate on our labels before showing a %** (S039: Brier
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
6. **Lifecycle (`oj.py audit`, session start):** proposes questions agents asked ≥ 5× that no pattern covers (→ new C row);
   flags C rows untested > 30 days and A/B rows unused > 60 days (→ measure or `"retired": {date, reason}` = tier R).
   Editing a measured question or pass rule in place fails `oj.py check` (question fingerprint) → add a new version (`P10v2`).
7. **Adding a pattern:** anyone may add a **C** row (question, use, rule, label source, baseline) to `registry.json`, then
   `oj.py render`. Label source must be real outcomes or history, or say "Claude-labelled" (weaker, flagged). Promotion
   only via eval + verify. Commit with `Refs: A150`.

## 6. Token-saving commands (OpenJev reads the text; you read only the result; usage logged)
| Command | Replaces | Pattern |
|---|---|---|
| `oj.py files --task "…" [--grep re] [dirs]` | reading every candidate file | P10 |
| `oj.py run -- <cmd>` | reading full test/build/log output (shows exit code, tail, flagged chunks) | P11 |
| `oj.py studies "<question>"` | scanning research/studies/INDEX.md | P14 |
| `oj.py dupes "<idea>"` | scanning ASKS + archive before filing | P13 |
| `oj.py skill "<task>"` | guessing which skill file to load | P15 |
| `oj.py analyze --spec …` | hand-combining many judgments | P21+ |
Each prints the pattern's tier. Below A the output is a ranked shortlist you still check; at A it may gate (skip) work.

## 7. Model choice (10-18)
OpenJev's small built-in models were tested on the same graded sets: Laya (2 GB) AUC 0.93 on output triage but 0.40 on file
relevance; Verdict (0.4 GB) 0.25 / 0.53. The 26B (20 GB) scores 0.98 / 0.84 → keep the 26B, share one instance.
Fine-tuning a small model on our labels is the only path to an always-on light tier (≥ 1k labels per task first).

## 8. Miss → teach → rebuild (Jamie 10-18: do not quit)
A miss is a **label**, not a kill. Agents are one-angle; OpenJev is a second angle — make it better with corrections.

```
oj.py outcome UID no
oj.py teach P10 --usage UID --missed path/a.ts path/b.ts   # "you forgot these"
oj.py eval P10 --build                                      # merges .agents/openjev/corrections/
oj.py ready A96                                             # Ideas stage second opinion (P27)
```

Skill: `.claude/skills/openjev-train.md`. Demotion (audit) drops verification so you re-measure — it does **not** mean retire.
Retire (tier X) only after teach + better state + rebuild still fail the rule. Keyword fallbacks are temporary shortlists
while `*v2` trains (see P14 notes).

Training levers (cheapest first): (1) hard examples via `teach`, (2) better input state, (3) `analyze` learned heads,
(4) calibration, (5) fine-tune at ≥1k labels/task.

## 9. Fildi score goals (Jamie 10-18) — don't quit after S039/R0x
OpenJev also exists to help **subjective** Fildi surfaces (fund/tech/options scores, internal FV, best put to sell,
Model List) while agents save tokens. Early tests (R01–R08, S039) were weak when the question was too big or the
state was the wrong shape. Same train loop, different packaging:

| Goal | Don't ask | Do instead | Labels |
|---|---|---|---|
| Fund / tech score | “Is this score right?” | Decompose: coverage thin? peer outlier? one metric dominating? (`analyze` features) | A102 dispositions + before/after snaps |
| Internal FV | “What’s fair value?” | Choice over bins vs street / our model; or noul “is street > our FV by >X%?” | realized 3–6m excess vs bins |
| Best put to sell | “Which put?” | Rank features already in scorer (IV/RV, DTE, OTM%) — OJ as second opinion on **ties**, not the scorer | S003 / optlab outcomes |
| Model List | “Pick winners” | Gate-only: quarantine / event / stale data flags (display) | trade_mistakes + survival |

Shared target for every agent: (a) **token save** via P10/P11/P27… and (b) **Fildi display aids** that beat a
cheap baseline on a pre-registered metric — never silent score changes (AGENTS rule 7). Miss → teach → rebuild;
rephrase or decompose before retiring.

Owner: Claude (PM) keeps the registry honest (session start: `oj.py audit`; re-verify on triggers). Jamie decides gates that change scores.
Any agent may `teach`.
