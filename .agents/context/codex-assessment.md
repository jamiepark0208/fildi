# FILDI — Astra assessment brief

## Jamie's goal
Can FILDI synthesize its data into sound, reasoned financial judgments, with evidence that supports conviction and exposes uncertainty? Assess the technology that makes those judgments possible and the financial reasoning itself. More tools, signals, elaborate explanations, or backtests do not by themselves establish better decisions.

Jamie wants a high-level assessment, supported by selected end-to-end traces and existing research. No new Codex responsibilities, app implementation, hook wiring, or team reorganization.

## Scope and method
- Work in `/Users/jamiepark/Cursor/fildi`; expected branch `cursor/mac-dev`. Record current SHA and relevant dirty paths; other agents are active. Recheck evidence before reporting.
- Apply `AGENTS.md`, `CODEX.md`, and `fildi-workflow`. Use `codex-context-map.md` and the topic index to choose context; no mandatory full-repo/Markdown inventory. Briefly orient on the AI tab and existing workflow, then focus on Jamie's goal.
- Local files/commands only. No desktop/network/vendor access, database writes, trading, deployments, queue changes, commits/pushes, or app/config edits. May write the report and Codex checkpoint. Missing runtime/data access becomes a specific limitation, not a reason to derail setup.
- CodeGraph CLI plus targeted search is sufficient. Work inline; bounded outputs, selective offline checks with understood side effects, no automatic full build or model-helper startup.

## 1. Technology: can we trust the delivery chain?
Map server, database, scheduled tasks, caches, APIs/providers, existing external tools, and UI. Trace representative data → normalization → scoring/model → displayed judgment paths. Examine freshness, point-in-time timestamps, units, provenance, nulls/fallbacks, conflicting sources, retries/rate limits, task idempotency, observability, performance, bugs, security, and relevant tests. Separate an architectural concern from an observed defect. Recommend tools only for demonstrated capability gaps.

## 2. Financial judgment: what does each output actually mean?
Cover fundamental, technical, and options scores; macro/regime; Model List; Track Record; Live; news/Street synthesis; conviction/forecast records. Group shared reasoning rather than reading each surface exhaustively.
- For each important output: intended decision, horizon, target, supporting evidence, uncertainty, and what would invalidate it. Distinguish descriptive quality, relative ranking, forecast probability, and trading policy. A score is not a probability without calibration.
- Evaluate the decision it feeds: put/call selection, strike, sizing/tail risk, avoidance, valuation, or monitoring—not stock direction by default. Use Jamie's strategy and existing study methods, while challenging unsupported assumptions in those methods too.
- Trace agreement/conflict among signals. Look for duplicated correlated evidence, circular confirmation, unsupported weights, stale narratives, missing negative evidence, and explanations disconnected from the actual calculation. Do not assume averaging everything into one score is sound.
- Examine plausible favorable AND adverse scenarios, base rates, alternative explanations, payoff asymmetry, transaction/fill costs, concentration, liquidity, assignment, and regime sensitivity as applicable. Distinguish model-implied probabilities from empirically calibrated forecasts. Identify when abstaining/no change is justified.

## 3. Evidence and self-learning: how would we know it improved?
Review relevant existing studies before proposing more. Inspect representative methods/results/code instead of trusting index labels.
- Backtests: point-in-time availability, survivorship/selection bias, look-ahead leakage, realistic contract history/fills, dependence/overlap, sample uncertainty, multiple testing, matched baselines, out-of-sample/walk-forward evidence, regime stability, and economic magnitude. State what cannot be tested with current data; no universal sample threshold.
- Subjective scores: explicit purpose/rubric, reproducibility/sensitivity, missing-data behavior, component ablations, and incremental decision value over simpler baselines. Separate construct validity from predictive skill and realized trading utility. Use calibration/proper scoring rules only for explicit probabilistic claims with defined outcomes/horizons; never invent probabilities from ordinal scores.
- Self-learning: determine what is actually implemented—recording outcomes, generating hypotheses, recalibrating, changing weights, or updating policy. Trace timestamped prediction/model version → independent outcome label → error diagnosis → proposed change → frozen evaluation → prospective/held-out comparison → approval/rollback.
- Repeatedly fitting to the same history, an LLM praising its own narrative, or a rising in-sample metric is not sufficient proof of learning. Examine champion/challenger separation, untouched evaluation data, drift detection, promotion/stop criteria, and downside regressions. Propose a testable loop where absent; do not build it or autonomously modify scores.

## Deliver a useful first pass
Write `.agents/context/codex-assessment-report.md`:
- Executive answer: technology readiness, quality of financial judgment, strength of supporting evidence, largest uncertainties. No profitability guarantee or invented maturity rating.
- Compact data/decision/feedback map; coverage marked inspected, sampled, deferred, or inaccessible.
- Up to eight prioritized findings: concrete consequence, current path/symbol/rechecked line or study evidence, observed vs hypothesis, smallest improvement, validation/falsification check, existing-task overlap. Include what already works.
- A short evidence roadmap: which decision needs which label/baseline/experiment; expected value as a hypothesis, cost, stop rule, and promotion/rollback condition. Do not default to adding ML, agents, APIs, or factors.
- Actual checks and limits. Distinguish documentation claims, code behavior, historical evidence, and prospective validation. Finish a ranked high-level pass rather than endlessly expanding scope.
Return a short summary. No source/config/queue changes.

## Effort and optional comparison
Start Astra at Light/Low; raise to Medium/higher only when depth is insufficient. Keep Jamie's explicit setting; do not claim to switch it automatically.
Optional efficiency pilot, not an automatic second assessment: use the same source snapshot and compact evidence packet for one bounded decision (e.g. what the technical score establishes for weekly put selection). Compare separate Light and Medium runs under the same output limit and rubric: grounding, correct target, leakage/baseline checks, uncertainty, actionable validation. Record elapsed time and actual usage if available; missing telemetry is unknown. Do not call a shorter answer better without checking quality.
