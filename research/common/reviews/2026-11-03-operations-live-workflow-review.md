# Sequential operational reviews 3–5 — schedules, Live, Ideas

Codex · 2026-11-03 · Moves: ops. Scope is reliability and workflow correctness, not score quality or trading edge. Initial source HEAD 65934a2e plus shared dirty tree; per-probe hashes identify the exact code exercised. No production code edits, vendor calls, browser use, external agents, or portfolio mutations.

## 3. Scheduled jobs / data freshness

**Verified:** read-only freshness check 24/24, daily.py today 11:48 ET ok. The prior IV30 freeze has a subsequent producer fix 040ad203 (recentre option-history legs after large price moves); today's freshness probe passes. This is not a claim of per-ticker complete IV coverage. Existing scheduler, catch-up/backoff and inventory tests: 29/29 pass.

**P1 finding:** `scheduler/state-guards.ts:runEventBulletsJob` catches a failed producer, logs it and records an attempt, then resolves normally. `scheduler/jobs-loop.ts:runMorningPrecomputeIfDue` appends its key to `ran` unconditionally. `run-morning-precompute.ts` therefore resolves successfully, and Maintain records exit 0. A busy job also appears in `ran` despite no execution. Success stamps are NOT incorrectly written in the injected failure; the defect is false aggregate success / skipped-versus-ran reporting. This behavior predates the A332 file split; do not call it a split regression.

Actual-source fixture: failed job → `ran=[events,earnings,analysts]`, no rejection, zero success stamps, one failure attempt. Busy fixture falsely includes events too. Normal-success control passes. Existing 29 tests do not cover producer-to-caller outcome propagation.

**Plan in A236:** typed outcomes (success / already-current / busy / failed), aggregate outcomes without losing independent successes, nonzero CLI exit for failed required work, retain bounded backoff and successful-job stamps. Do not blindly throw from every scheduled wrapper: unattended callers must handle failures without unhandled rejection. Fixture failure, busy, success, partial success, and bounded retry; no paid requests in tests. Keep this separate from A332's behavior-neutral refactor.

## 4. Live tab runtime reliability

**Verified:** 19 tests across hotlist overlap, risk-level hold, outlook cache keys, breadth-drop and trend-fall behavior pass. Fixture-only DATABASE_URL, no real connection. Current live-risk TTL is 50 seconds with documented 60-second UI polling. Hotlist membership is intentionally manual refresh after startup; UI exposes last-refreshed time and a refresh control. No automatic fan-out proposed.

**P1 finding:** `routes/live.ts` cold `/live/state` runs `void liveHotlist.refresh()` without a rejection handler. `live-hotlist.ts:doRefresh` awaits a DB query which can reject. The route's synchronous try/catch does not catch this background promise. `index.ts` handles unhandledRejection by shutting down with exit 1.

Actual-route fixture: snapshot response succeeds, Express next receives no error, rejected refresh emits an unhandledRejection. This reproduces the rejected background promise without crashing or touching the live API; the shutdown consequence follows from the entrypoint handler. It does not prove this caused any observed restart.

**Plan in A251:** catch/log rejection at every detached refresh call; retain shared in-flight deduplication and saved response. Introduce bounded retry/backoff for cold refresh failures so the existing two-second initial UI polling cannot hammer a failed producer. Keep the last successful snapshot; expose refresh failure/age. Tests: rejected refresh yields zero unhandled events; N simultaneous requests cause one refresh; repeated failures respect backoff; a later success clears the error. No vendor warmup added per page request.

## 5. AI Stage / Ideas visibility

Executed the actual Ideas parser, not a new approximation. A318, A329 and A277 are present with Codex review text in the 1,600-character excerpt; A318 is assigned Cursor in the filed/revision phase, A329/A277 in reviewed. This verifies backend parser output, not authenticated browser rendering or a live agent running.

**P2 finding:** queue count increments only for open/planned/accepted/partial and uses raw destination. A one-row Cursor→Claude `revise` fixture produces an Idea assigned Cursor but queue counts zero for every agent. Routing/counts are inconsistent. Multiple comma/plus recipients can also disappear because `who()` expects one name: A251's old FYI recipient list and A234 are examples. A251 is normalized to one primary owner in this handoff; the general parser issue remains.

**Plan in A205:** compute a primary assignee once, use it for both card and actionable queue; include revise, exclude done/verified/parked; preserve explicit review owner. Support secondary reviewers as metadata or reject ambiguous routing visibly, never silently drop the task. Fixtures cover revise author/builder, needs-Claude, multiple recipients, parked/done, and current A318/A329. Keep usage/accounting and model configuration unchanged.

## Handoff and evidence

- A236 reopened for precompute outcome propagation; A251 reopened for Live refresh failure isolation; both need Claude plan review, then Cursor implementation. A205 holds the narrowly scoped Ideas follow-up. These are actionable plans, not claims of shipped fixes or live dispatch.
- `2026-11-03-precompute-probe.cjs` + results: actual functions, two failing fault cases and a passing success control.
- `2026-11-03-live-refresh-probe.cjs` + results: actual route, rejected refresh captured.
- `2026-11-03-ideas-parser-probe.cjs` + results: current board visibility and isolated revision-count failure. Run all probes with node from repo root. Fault probes intentionally exit nonzero until repaired.
- Existing tests ran with `node --import tsx --test` from artifacts/api-server, avoiding the tsx CLI's IPC permission issue. 29 scheduler + 19 Live = 48 passing checks. No full-suite rerun or claimed token-savings percentage.
- Full authenticated UI walkthrough, reboot testing, vendor budget stress tests and numerical subscription allowance were not performed. No claim that every operational path is now verified. Business score/recommendation assessment remains separate as Jamie requested.

**Review/planning pass complete for these three areas.** Next work is implementation and independent verification of the explicit tasks, not another discovery loop or asking Jamie to restate the same request.
