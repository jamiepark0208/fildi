# Review 2 — Stock DB data correctness

Codex · 2026-11-03 · Moves: ops / trustworthy fundamental inputs.
Scope: A318 price-ratio repair and A329 audit status, negative-equity handling, currency/provenance integrity. Business quality of scores and recommendations is separate, per Jamie. No rescoring, vendor calls or production writes.
Snapshot: HEAD 4e97ebbe plus the shared working tree. Cursor holds A329 round 6 and is changing derived-metrics / merge-trusted; this review changes only evidence and task documentation. Source hashes are in the fixture receipt.
Existing: A318 owns the gold picker; A329 owns the population audit. Extend these, no duplicate engine/task.

## Verified

- 30 existing focused tests pass: derived-metrics.fixture.test.ts + stock-db-audit.test.ts. Run without the tsx CLI's restricted IPC server: `node --import tsx --test ...` from artifacts/api-server. Test execution reported 106 ms; this is not whole-review time.
- Read-only, whole-table snapshot: 958 ticker_fundamentals rows; P/E and EPS populated on 939 each. Coverage is not accuracy.
- All 50 negative-equity rows have D/E and ROE null: zero leaks. This confirms the intended A329 producer repair across the affected population.
- Zero stored EV/EBITDA values below zero or above 200. This establishes the configured validity band, not correct units/periods/definitions.
- The live A329 report covers a different population: 914 fetch-universe names, seven statement-level fields. Its 12,796 cells count two audit layers over 6,398 name/field pairs, not 12,796 distinct fields. Round 6 remains in progress; do not declare the database clean from coverage or an evolving SEC match rate.

## Confirmed findings

### P1 — EV repair bypasses currency eligibility in two places

`merge-trusted.ts` first calls `shouldForceDerivedPriceRatio`, which rejects known non-USD financial currency and requires agreement for unknown currency. But:
1. The `forceDerived` closure turns a rejection into approval when vendor EV/EBITDA is outside the band and the derived result is inside it.
2. The later `let evGold` repair block recalculates and stores the ratio without calling the currency/field-agreement guard at all.

Offline reproduction executes both actual source blocks, not a copy of their logic. USD price 100, shares 1B, statement debt 50B, cash 10B, EBITDA 20B and vendor ratio 2059 produce a numerically plausible 7. Both paths store that ratio for known CNY statements. The later repair also accepts unknown currency with no agreeing vendor. Two USD controls pass. A number inside the validity band is not evidence of compatible units.

**Fix:** route normal derivation and extreme-value repair through one eligibility function. Retain the per-field currency/agreement rule. If explicit input provenance proves currency conversion, test that supported path; do not use a plausible output range as a substitute. Otherwise retain a valid vendor ratio or mark Needs Review while repairing the source inputs. Remove the separate unguarded write path.

**Acceptance:** known non-USD without conversion and unknown currency without agreement never get a derived replacement in either branch; valid USD/conversion controls still work. Scan all derived price-ratio fields after the fix, including stale provenance. Explain every exception before rescoring.

### P2 — the later repair can erase a manual override

The same `let evGold` block does not check overrideIndex or provenance.isOverride. The fixture seeds an explicit overridden EV/EBITDA of 2059; the repair changes it to 7 and stamps `isOverride: false`. The earlier forceDerived path does have override checks, so tests of that path alone miss this.

**Fix:** apply override protection before every repair write. An implausible override can be flagged for review without silently replacing its value/authority. Add a direct repair-path regression test, including financial-sector clearing and existing overrides.

## Database follow-up, not three proven bad valuations

The read-only scan finds three populated price-ratio fields with derived provenance and a latest Yahoo financial currency other than USD: GFL P/E (CAD), LI P/E (CNY), ASML EV/EBITDA (EUR). Receipt retains values and provenance timestamps. Currency at the company level does not prove the currency of each chosen vendor field, and old derived provenance may persist. Resolve each from stored input provenance before labelling its value wrong; this review made no vendor requests.

Existing A318 EPS/P/E follow-up still matters: choose a consistent TTM EPS and carry its period/source into P/E. A329 round 6 already owns GAAP vs adjusted EBITDA, cash definition, period mismatches and the twelve reported gold errors. Reuse that work, do not restart it. Later per-share/ADR audit remains an A329 stage, not independently cleared here.

## Handoff / cheapest verification

- Cursor: fix both bypasses in the existing merge path while completing A329; preserve active statement-level work. Claude: review the integrated result before rescore.
- Promote the extracted-block cases into normal regression tests. The current 30 tests exercise helpers, but do not establish these composition-level guarantees.
- Run the whole affected derived-ratio population after producer changes. With unchanged producer hashes, inspect only newly changed rows; do not repeatedly fetch SEC/FactSet data for this bug.
- A318 reopened to revise for these repairs (index and detail agree). A329 remains under its current owner/status. No claim of implementation or verified completion.

## Evidence

- `2026-11-03-stockdb-repair-probe.cjs`: run with node from repository root; actual source blocks, fake values, no database/app boot. Four fault cases fail as expected for this review; two normal controls pass. The probe exits nonzero until the defects are repaired.
- `2026-11-03-stockdb-repair-results.json`: source hashes and six results. Source hashes still matched at closeout.
- `2026-11-03-stockdb-read.py`: bounded read-only local queries; no credentials in output. `2026-11-03-stockdb-db-results.jsonl`: aggregate coverage, negative-equity checks and three provenance candidates.

Operational assessment: the new guards remove specific bad-input classes, but successful arithmetic and high coverage still allow wrong-unit values through repair branches. Close that producer gap before treating Stock DB as verified. No conclusion about the predictive value of FILDI scores or trades.
