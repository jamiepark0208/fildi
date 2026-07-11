# portfolio-analysis-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | ui (+ thin schema only after design) |
| **Effort** | L (ship 5a first = S; wheel/journal = L) |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [portfolio-daily-brief](9-portfolio-daily-brief-improvements-070926.md), [ai/13](../ai/13-product-ai-trade-journal-loop-070926.md), [ai/14](../ai/14-product-ai-trader-account-research-070926.md) (Phase 0 journal/tag schema may also serve AI memory — single migration owner), [feed](13-feed-improvements-070926.md), [profile](14-profile-track-record-improvements-070926.md) |
| **Type** | ENHANCE (+ NEW only after design) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Make Portfolio a risk command center for CSP/wheel traders: unlock nav, deep-link risk → breakdown, show cost basis where data exists; later wheel-cycle + journal tags (**design before migration**).

### Cache / DB compliance
Reuse `GET /api/portfolio/snapshot/latest` + existing ingest. **No** serve-time vendor calls. **No** Redis. **No** second portfolio analysis API.

---

## 1. Executive summary (rescoped)

**Do not** invent broker OAuth, pg-boss sync, or a second `PortfolioAnalysis`.

**Do** ship **5a enhance-first** immediately:
1. Remove `adminOnly: true` on Portfolio nav
2. At-risk / concern rows → breakdown deep link
3. Surface effective cost basis from snapshot fields when present

**Defer** wheel-cycle object + journal tags until Phase 0 design agrees with [ai/13](../ai/13-product-ai-trade-journal-loop-070926.md) (single migration owner).

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Portfolio hidden from non-admins | `sidebar.tsx` L53 — `adminOnly: true`; filter L243 |
| Analysis already rich | `PortfolioAnalysis` — allocation, sector, risk, net delta, income, Safe/Watch/At Risk |
| Robinhood path works | `PortfolioUpload` → `POST /api/portfolio/ingest`; page uses `portfolio-snapshot-latest` |
| Manual boxes exist | `PortfolioBox` in `portfolio.tsx` |
| Learning loop missing | No journal tags on portfolio close; ai/13 owns feed close tags — **coordinate** |
| Brief separate | DailyBrief → enh/9 |

---

## 3. What (build scope)

### In scope — Phase A (ship first)
| # | Work | Status |
|---|---|---|
| A1 | Sidebar: `adminOnly: false` (or remove flag) for portfolio | **Deferred 2026-07-11** — see rescope note below |
| A2 | Position health / at-risk row → `/breakdown?ticker=` or existing breakdown route pattern | ready |
| A3 | Display effective / adjusted cost basis where snapshot premium or avgCost fields exist | ready |
| A4 | Import history list (ingest timestamps) if API already returns history — else list latest only + “last imported” | ready |

#### Rescope note (2026-07-11, alongside bug/14)

A1 is **deferred, not implemented**. Owner decided the Robinhood-CSV admin view and
a regular-user manual-entry view need to stay two different experiences rather than
one unlocked-for-everyone page — CSV upload stays admin-only, regular users get a
manual "Add Position" flow instead once the tab opens up. That split (admin branch
vs. regular-user branch in `portfolio.tsx`, both server-backed via
`use-portfolio.ts`) was built as part of bug/14's fix, so the machinery for A1 exists
and works — the nav flag (`sidebar.tsx` `adminOnly: true`) just hasn't been flipped
yet, intentionally, until the regular-user experience gets more real-world use by the
single current admin. Flipping it later is a one-line change once ready. A2–A4
untouched, still `ready` for whoever picks this up next.

### In scope — Phase B (design-gated)
| # | Work |
|---|---|
| B1 | Wheel cycle grouping design doc (legs by ticker + date chain) — **before** DB |
| B2 | Journal tags — **same schema decision as ai/13**; portfolio may *display* tags; feed close may *write* them |
| B3 | Weekly “one fix” prompt (Edgewonk lite) — after tags exist |

### Out of scope
| Item | Reason |
|---|---|
| Broker OAuth | Separate product |
| Second PortfolioAnalysis / Redis | Drift / R6 |
| Inventing job queue for sync | enh/28 |
| Writing `.cursor/context/lessons.md` from trades | ai/3 / R5 |
| Duplicating daily-brief LLM | enh/9 |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Nav adminOnly | `sidebar.tsx` — portfolio item `adminOnly: true` |
| Route exists for all authed users | `App.tsx` `/portfolio` behind `ProtectedRoute` only — **nav** is the gate, not the route |
| Snapshot API | `portfolio.tsx` L743–745 — `GET /api/portfolio/snapshot/latest` |
| Ingest | `PortfolioUpload` → `POST /api/portfolio/ingest` text/plain CSV |
| Parser | `portfolio-parser.ts` — Robinhood multi-section CSV |
| Schema | `portfolio_snapshots` + related position/option/order tables (~L545+) |
| Analysis component | `PortfolioAnalysis` imported in portfolio page |
| Manual entries | `PortfolioBox` in same page |
| Journal tags on trade_posts | **Absent** (ai/13) — don’t invent parallel portfolio-only tag table without design |

### 4.2 Files to modify (Phase A)

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/components/sidebar.tsx` | Drop `adminOnly` on portfolio |
| **P0** | `artifacts/stock-compare/src/components/portfolio-analysis.tsx` (or wherever health rows render) | Link ticker → breakdown |
| **P1** | `artifacts/stock-compare/src/pages/portfolio.tsx` | Cost basis display; last-imported UX |
| — | New portfolio API | **Avoid** unless history list needs `GET /api/portfolio/snapshots` |

### 4.3 Files to read but **not** modify (Phase A)

| Path | Why |
|---|---|
| `routes/portfolio.ts` | Confirm snapshot/latest + ingest contracts |
| `portfolio-parser.ts` | Field names for cost basis |
| `schema` portfolio_* | Don’t migrate in Phase A |
| ai/13 pack | Journal co-design |
| enh/9 | Brief — don’t fork |

### 4.4 Phase B design checklist (block migration)

- [ ] Wheel cycle: pure UI grouping of snapshot legs vs new `wheel_cycles` table?
- [ ] Journal: columns on `trade_posts` (ai/13) vs portfolio-specific — **one owner**
- [ ] Privacy: no P&L into Cursor lessons.md
- [ ] Adjusted cost across rolls: formula documented with examples

### 4.5 Acceptance criteria

**Phase A**
- [ ] Non-admin user sees Portfolio in sidebar
- [ ] Non-admin can open `/portfolio` (already routed) and use upload if permitted by API auth
- [ ] At-risk put/concern control navigates to breakdown for that ticker
- [ ] Cost basis shown when data present; “—” when not — no invented numbers
- [ ] No new Redis / second analysis API
- [ ] stock-compare typecheck

**Phase B**
- [ ] Design checklist complete before Drizzle
- [ ] Agreed with ai/13 on journal fields
- [ ] lessons.md untouched by feature

### 4.6 Suggested commit messages

Phase A: `feat(portfolio): unlock nav and deep-link at-risk positions`  
Phase B: after design — separate commits per migration/UI

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **ai/13** | Journal tags co-design (hard for B2) |
| enh/9 | Brief improvements — parallel, don’t merge LLM |
| enh/13 / 14 | Feed/profile track record — soft |

---

## 5. Data note
Snapshots already in Postgres. Phase A = UI only. Phase B may add nullable columns — Drizzle only after approval.

## 6. Impact & Risk Analysis

### 1. Blast radius
- Phase A: sidebar + portfolio UI  
- Phase B: schema + feed/portfolio  
- Rollback: restore adminOnly; hide links

### 2. Bug introductions
- Unlocking nav exposes unfinished UX to all users — Phase A must be coherent
- Wrong breakdown URL pattern — match existing app routing (`/breakdown` + ticker state)
- Double journal schemas — force ai/13 agreement
- Catch: login as non-admin; open portfolio; click at-risk

### 3. Performance
- No new hot-path fetches; reuse snapshot query

### 4. Workflow
- Before: admin-only portfolio  
- After: all users + risk deep links  
- Journal later

### 5. Drift
- Paired: sidebar flag ↔ product expectation; journal ↔ ai/13 ↔ feed close

### 6. Scalability
- Snapshot size fine for single-user CSV; multi-account already in parser

**Do not:** OAuth; Redis; lessons.md writes; second analysis service.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — Phase A ready; Phase B design-gated  
**Was:** thin draft. **Now:** verified adminOnly gate, snapshot/ingest paths, explicit ai/13 boundary.
