# FILDI improvement agenda — 2026-10-19
Parent: A207; synthesis overlap A166. Codex proposal, not implementation approval or proven financial benefit. This supplements the defensive first-pass audit with product and research opportunities. Source: current fildi-feature-synthesis.md, model-thesis-report.tsx action tickets, learn.py champion/challenger flow, A190 house view and existing ASKS. Runtime coverage remains selective.

## Product thesis
FILDI already has substantial analysis machinery. The opportunity is to make the next decision easier to understand, compare and revisit—and measure whether doing so helped. More factors, screens or agents should earn their place. This is a hypothesis to validate against current workflows, not a claim that synthesis is wholly absent.

## 1. A decision-change digest, built into the current daily workflow
Existing: action tickets already explain what/size/trigger/why; A190 house view flags coherence; Today-strip work overlaps. Do not build a second dashboard or explanation engine.
Proposed delta: compare current and previous frozen recommendations and report only material changes: changed eligibility/size/strike, new counter-evidence, deteriorated book capacity, expired evidence or a thesis kill condition. Explain the causal input, its timestamp, whether it changes the action, and what would reverse the decision. Explicitly allow 'nothing material changed'.
Example: 'Stock still qualifies, but the candidate now breaches your existing concentration constraint; reconsider this candidate.' No invented probabilities or new risk thresholds.
Value hypothesis: fewer tabs and repeated prompts to understand what needs attention.
Eval: frozen before/after fixtures for no change, real change, stale inputs and contradictory signals; all material rule changes retained, no stale-only refresh presented as new research. In a small user walkthrough compare time/clicks and missed changes against today's tickets. Stop if it duplicates existing behavior or produces alert fatigue.
Owner: Codex product trace/prototype specification; Cursor UI build after existing review. Reuse A190/A166 and uniquely resolve conflicting A179 IDs before reference. First check current UI because action-ticket behavior is already partly present.

## 2. Compare candidates by their marginal effect on the book
Existing: PM Alerts MC, crash budget, effective bets and close-position what-if. Reuse that risk engine; no second Monte Carlo stack.
Proposed delta: compare shortlisted additions/replacements with 'do nothing' under the same book snapshot. Show change in assignment cash needs, concentrated exposures, existing stress-budget consumption and attainable net premium. Keep standalone quality visible; a good standalone contract may be a poor addition to this book. Account constraints remain explicit.
Value hypothesis: helps avoid several attractive-looking positions expressing the same risk.
Eval: deterministic fixtures for existing exposure overlap, insufficient cash, protected account boundaries and same trade at different sizes; then frozen prospective shadow comparisons against current selection under equal constraints/costs. Record infeasible trades and no-action decisions. No claim of improved returns from reduced risk alone. Stop if incremental ranking is unstable to reasonable correlation/stress assumptions.
Owner: Claude quant plan/eval; Codex independent verification; existing PM/A76/A161 ownership for implementation. Higher effort, high decision relevance; do after A206 correctness fixes.

## 3. Show how robust a recommendation is, not just its score
Existing: coverage/peer controls, versioned scores, multiple FV models and assumptions ledger.
Proposed delta: perturb uncertain inputs within defensible source ranges, use alternate eligible peer sets, omit redundant factors and vary fills. Report whether eligibility/action changes and the smallest assumption change that flips it. Use explanations such as 'stable across tested assumptions' or 'depends on this input', not fabricated confidence percentages.
Value hypothesis: users distinguish sturdy conclusions from precise-looking but fragile ones.
Eval: sparse-data, conflicting-vendor, peer-boundary and near-threshold fixtures; controlled ablations on existing point-in-time data. Verify economically irrelevant perturbations do not create dramatic UI changes, while relevant dependencies remain visible. Stop if the sensitivity view adds no information beyond existing coverage flags.
Owner: Claude methods; Codex initial fixture design; Cursor presentation. Reuse score/assumption homes and A191; no new mega-score. Medium effort.

## 4. Make learning diagnose decisions and components
Existing: forecast ledger, Track Record, versioned snapshots and learn.py challenger/promotion flow. Earlier review's 'incomplete learning' did not mean none exists.
Proposed delta: evaluate the frozen chosen action alongside declared alternatives: no trade, simpler ranking, same contract without a specific filter, alternative size/structure under equal constraints. Classify discrepancies as bad/stale data, eligibility bug, pricing/fill assumption, sizing/concentration, timing, or ordinary outcome noise. Track chosen and rejected candidates prospectively so hindsight does not choose the baseline. Distinguish research improvement from favorable regime exposure.
Value hypothesis: stops agents responding to every loss with another factor and connects improvement plans to attributable outcomes.
Eval: known-error fixtures must route to the correct diagnosis; immutable version/decision-time evidence; paired weekly/regime comparisons with costs and tail checks; stop promotion if gains disappear against the simple baseline. Do not fit explanations to the same history and call that learning.
Owner: Codex diagnosis/evaluation specification; Claude quant review; use existing ledger/learn.py, not a new journal. Medium/high effort; start with one put-selection decision.

## 5. Turn research into an evidence queue with graduation and retirement
Existing: study index, preregistration, ASKS, OpenJev tiers and outcomes ledger.
Proposed delta: every deployed claim links to its supporting experiment/version and scope; every experiment names the decision it could change, cheapest decisive test and stop rule. Surface when a failed study is still cited as a success, when evidence expires or does not transfer to the live contract/horizon, and when a candidate has enough new prospective evidence to revisit. Prioritize by uncertainty that blocks a real decision, not novelty.
OpenJev extension: route validated extraction/triage tasks only; benchmark simple rules, local model and current approach on the same cases. Measure kept failures, useful coverage, latency and actual total cost—not merely calls moved off a hosted model. Retired forecasting experiments require a new hypothesis before repeating.
Value hypothesis: less research churn and fewer unsupported live claims.
Eval: seed stale/correct/mismatched evidence references and verify alerts; compare completed decision-relevant experiments per unit effort before and after. Stop if it becomes another manually maintained catalog. Existing index/registry are the source of truth.
Owner: Codex audit/plan; Claude studies; Muse outcome-review lane. Reuse A129/A150/A166/A207. Low/medium effort. No new provider or plugin justified until existing data cannot answer the next decisive question.

## 6. Make autonomy complete a bounded unit of useful work
Existing: Stage, Ideas, claims, reviewer gates, ship checks and weekday Codex review heartbeat. The heartbeat is review-only; it does not currently finish code tasks automatically.
Proposed delta: an eligible row is self-contained enough that a builder needs no new kickoff: problem, permitted paths, owner, baseline, acceptance test, dependencies, access class, budget and stop condition. A bounded builder claims one ready task, executes existing ship checks, submits evidence for independent review and records the outcome. Show 'implemented / tested / reviewed / outcome measured' separately in AI, alongside blockers and budget evidence. Auto-retry only defined transient failures; never keep spinning indefinitely.
Value hypothesis: fewer Jamie interventions per verified useful change, not more commits or animated activity.
Eval: dry-run one low-risk task through claim collision, missing dependency, test failure, budget exhaustion and independent-review completion. Preserve both tasks on ID collision. Only then consider recurring builds with separately specified limits; current review automation stays unchanged.
Owner: Codex A207/A205; independent reviewer through existing team. Low/medium effort. No multi-model orchestrator or broad permission grant needed.

## Recommended sequence
1. Finish A206 correctness and A205 actual activation verification.
2. Trace and prototype the decision-change digest against current action tickets; measure whether it removes real effort before building.
3. Add evidence-to-claim/retirement checks and one complete bounded-task rehearsal to reduce prompting and research waste.
4. Run marginal-book comparison and robust-decision sensitivity as shadow studies; promote only with explicit acceptance evidence.
5. Expand attribution beyond one decision only if the first diagnosis loop changes a useful action.

## Review quality change
Each future feature review should produce two separate answers: (a) what is unreliable or unproven, (b) what would make this decision/workflow materially better. It may conclude no enhancement is warranted. For any proposal, state existing overlap, concrete user benefit, smallest change, falsification test, cost, owner and stop rule. Do not count fixing arithmetic as a complete product assessment. Do not manufacture novelty merely to fill an ideas quota.
