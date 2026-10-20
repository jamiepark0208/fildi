# FILDI: one review pass per area — 2026-10-19
Owner: Codex. Parent: A207. Source HEAD: 48322b4; shared dirty tree, not a frozen release. Review only: no application, portfolio, vendor or scoring writes. This is engineering/evidence triage, not a new return backtest or a complete audit. No paid calls, model startup, new plugins or deployment.

## Outcome
Ten areas sampled. 103 selected tests passed after resolving a test-environment import issue. Six additional direct checks passed (three structure checks, three admin-access cases). One existing Focus failure independently reproduced again. A stale-macro input produced a current-sounding implication; this is a helper-level observation, not proof that the full UI hides staleness. No historical study re-run or authenticated UI/production-data verification.

## 1. Options rankings / Model List
Inspected attachFocus and A206 fixes. Actual TS function executed with mocked database responses: trim candidate Q5 and another candidate Q1, no eligible candidates. Both received focus=true. Expected empty Focus. Existing A206 finding remains open; no new duplicate row.
Strength: actual demotion state now consumed in Python and TS; trim filters present in primary branch. Risk: empty and error fallbacks bypass primary eligibility. Holiday mismatch from the previous independent fixture remains unresolved on unchanged source. Owner Claude corrections; Codex verifies. Pass: no excluded candidate in any fallback; shared market-calendar entry/expiry fixture agrees with calibration. Do not use the same inspected historical slice as new untouched evidence.

## 2. Track Record / forecast accountability
Inspected model-track-record.ts snapshot versioning/live-bid guard and model-track-grade-recs.ts settlement flow. Ran 3 path-risk tests, 6 settlement/assignment tests, 5 forecast-helper tests, all pass.
Strength: snapshot versions, explicit NO_DATA handling, assignment follow-up and adverse-path accounting exist. Gap: grader treats absolute moves over 60% as split-like and excludes them; a genuine crash could also satisfy this rule. This is a potential selection-bias mechanism, not a demonstrated production misgrade. Next test: compare true corporate-action metadata versus genuine crash fixtures; show excluded counts alongside success rates. Actual immutable forecast replay and live performance reconciliation remain unverified. Owner Codex analysis, then existing quant owner for any change.

## 3. Fundamental / technical / option scores
Ran fund-score-guards and optional-metric tests; sampled current coverage suppression and ordinal confidence logic. Guard, coverage and Street tests in the selected suite pass.
Strength: extreme-growth caps, thin/speculative adjustments and sparse-data controls are explicit. Gap: arithmetic tests do not establish that chosen priors, multipliers or weights improve the intended financial decision. Next: one factor-family sensitivity/ablation against a simpler matched baseline, using existing study machinery; no score promotion without before/after and independent review. Option score/put-edge version parity remains in A191/A206. Technical score full reconstruction deferred.

## 4. Strategies / Research
Inspected structures.py payoff/pricing assumptions and admin-gated Strategies endpoint; sampled Research Ops local-probe route and data entitlements context. Direct expiry put/payoff checks and calendar exclusion pass (3 checks).
Strength: calendar deliberately unranked because fixed-IV pricing produced misleading results; option structures label simulated inputs and use bid/ask-based fill assumptions. Risk: ev_rv uses a zero-drift lognormal distribution with trailing realized volatility. Ranking across margin/capital denominators is not evidence of risk-adjusted superiority. Phase 2 backtest is still described as future work. Next: freeze assumptions/version, compare against simple structure baselines with gap/tail/correlation/fill stress and prospective results. Reuse A192; do not build another strategy lab. Research UI itself not visually verified.

## 5. Macro / regime
Ran macro-implications threshold tests, all pass. Direct actual-helper fixture: VIX=40 dated 2000-01-01 still outputs stress and a present-tense hedge/premium implication. macro-utils.sortedByDate sorts but does not age-filter. Wrapper/cache timestamps do not by themselves establish observation freshness.
Strength: deterministic threshold semantics and explicit conflicting signals. Gap: freshness must be verified end-to-end per economic series, with appropriate release frequency; stale helper output is a risk, not yet a confirmed UI defect. Next: trace observation date through each consumer, add fresh/stale/missing/revised fixtures and distinguish data agreement from calibrated probabilities. A190/S057 overlap; avoid restarting rejected direction studies.

## 6. Live / news / Street
Ran Street conflict synthesis, recommendation-conflict, news-quality sanitization and Live hotlist tests. All pass after providing an inert database URL for the otherwise pure hotlist test. No portfolio database connected.
Strength: missing sources return neutral; conflicting recommendations remain visible; dip/rally overlap partitioning works; OpenJev headline endpoint explicitly labels output as not a forecast.
Gap: these fixtures do not measure source factuality, headline recirculation or incremental usefulness. Next: a small frozen source-linked sample with arrival/event timestamps, duplicate stories, negation and contradictory evidence, graded against deterministic extraction. Refactor test boundary only if repeated DB-import coupling wastes verification effort; no standalone speculative refactor row.

## 7. OpenJev
Inspected REGISTRY.md, oj.py study/duplicate retrieval and openjev_local.py question generation; 14 privacy/input tests pass. P11 failure retention is tier A; evidence does not automatically establish net token/time savings. oj.py studies uses keywords because model P14 failed—good evidence-driven fallback.
Observed: questions_for still produces put_otm questions while registry R06 rejects put-probability skill. No registry/retirement gate found in that generator. Sampled recommendation consumers did not show those answers changing Model List scores; do not label this proven live trading contamination. Next: explicitly classify this as retired, shadow experiment or production use; shadow needs a bounded revised hypothesis/stop rule and separate evidence. Reuse A129/A150. Measure regex-only vs regex+model failure recall, latency and total reading cost. No model started during this review.

## 8. APIs / tools / plugins
Ran mocked HTTP retry, permanent-error, URL-redaction and concurrency tests; all pass. Sampled Research Ops probes local caches/TCP rather than invoking vendors, plus existing entitlement map and efficiency playbook.
Strength: shared retry/redaction infrastructure and cached operational health. Gap: passing wrapper tests does not prove all callsites use it or that entitlements/rate limits remain current. Next: trace one high-value provider chain, inventory bypasses and timestamps, inject timeout/429/stale fixtures and compare existing tools against any proposed addition. No new plugin/API justified by this pass; no need to install tools for their own sake. Reuse A185 and existing data-source maps.

## 9. AI / autonomous workflow
Seven targeted identity, Ideas routing, inbox and telemetry-privacy tests pass. Hooks configured, real delivery and logged-in Stage still not verified. Existing index contains duplicated A179–A182 identifiers; a previous A193 collision was repaired locally. These are observed coordination risks, not hypothetical.
Strength: existing ASKS/claims/outcome ledger can support the loop. Gap: claim convention and sequential numeric IDs are not globally atomic across the remote git bus. Next: conflict-aware ID allocation/validation before accepting an index merge, preserving both asks; test two simultaneous filings. Reuse A66 history and A207; no second task tracker. Activity animations must not be reported as achieved outcomes. A205 remains partial.

## 10. Settings / access / operations
Scheduled-task inventory/alert tests pass. Executed requireAdmin with anonymous, ordinary and admin sessions: 401, 403 and allowed respectively (3 checks). Sampled Research Ops access uses authentication; sensitive Strategies endpoint requires admin.
Strength: access middleware and maintenance alerts exist. Gap: unit middleware tests do not prove all endpoints invoke it; actual host rights and service privileges differ from workflow prose. Next: endpoint authorization matrix and fault-injected scheduler/maintenance recovery; report source/time of permission evidence. Avoid dumping credentials/portfolio contents. Full authenticated Settings review deferred.

## Test evidence and limits
Selected Node suite: 66 passing tests plus one loader failure from live-hotlist.test.ts due missing DATABASE_URL. Re-run only hotlist with inert postgresql://fixture:fixture@127.0.0.1:1/fixture: 5 pass. No network/database use in those pure functions; connection pool is lazy. Additional Node settlement suite 6; Python OpenJev 14; Python forecast ledger 5; agent routing/privacy/inbox 7. Total 103 passed. Initial loader failure remains recorded, not hidden. Commands/logs during run: /tmp/fildi-feature-tests.log, fildi-live-tests.log, fildi-settle-tests.log, fildi-openjev-tests.log, fildi-ledger-tests.log, fildi-agent-tests.log. Logs are temporary; this record retains counts, paths, outcomes and limitations.
Focus regression reproducer: research/common/reviews/2026-10-19-codex-focus-fixture.mjs (run from repo root with Node; executes extracted actual TS function, mocked DB only). It prints the failure; it does not modify app state.

## Workflow lessons from this pilot
- One focused evidence packet per area: decision, 1–3 source paths, relevant tests, observed result, uncertainty, owner, next falsification. Avoid large combined file dumps; several outputs were truncated and required narrower reads.
- Preflight test imports and side effects. Use existing venv and fixture-only configuration; never load real credentials just to satisfy a pure-test import.
- Separate behavioral tests, economic evaluation and visual/runtime verification. Passing 103 tests does not prove profitability or full coverage.
- Reuse existing rows; append independent review before reading the implementer's verdict. Review fixes without silently marking self-work verified.
- Record failed hypotheses and missing access explicitly. Do not repeatedly test unchanged passing paths. Re-run only touched or unresolved paths.
- Bounded recurring review has a time instruction, not a guaranteed platform-enforced spend cap. Stop/checkpoint at limit; never add fan-out or inference merely to fill a run.
- Save immutable per-run evidence and latest per-area status. The next weekday run should address A206 correctness first, then macro observation freshness and OpenJev use-policy reconciliation, rather than repeat this entire sweep.

No new enhancement is approved for implementation by this report. Proposed improvements above need their existing-row owner/review gate. Jamie requested the review pilot, not automatic score changes or new services.
