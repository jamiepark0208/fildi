# onboarding-product-tour

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | ui |
| **Effort** | M (~1–2 build sessions) |
| **Created** | 2026-07-09 |
| **Source** | competitive-ux-research |
| **Related** | [1-competitive-ux-research](1-competitive-ux-research-070926.md), [3-contextual-score-explanations](3-contextual-score-explanations-070926.md), [4-home-dashboard-redesign](4-home-dashboard-redesign-070926.md), [enh/20 scorecard-guide](../enhancements/20-scorecard-guide-improvements-070926.md) |
| **Type** | NEW (frontend-only; enhance existing nav/settings) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Orient first-run CSP traders: rankings → scanner → watchlist → scoring reference — without a new API or DB column.

### Cache / DB compliance
**localStorage only** (`fildi_tour_v1_{userId}`). No Redis, no migration, no vendor calls. Tour overlays headers/nav only — does not wait on rankings/scanner fetches.

---

## 1. Executive summary (rescoped)

**Do not** add `react-joyride` / driver.js, server `onboarding_completed`, analytics events, or interactive “click this” quests.

**Do** ship a 4-step custom spotlight tour (portal + `data-tour-id` anchors), persist completion per `AuthUser.id`, replay from Settings → Profile. After [home redesign](4-home-dashboard-redesign-070926.md) ships, bump `TOUR_VERSION` and retarget step 1 copy/anchor — do not block this task on /4.

---

## 2. Why (line-level evidence)

| Requirement | Evidence |
|---|---|
| No “start here” path; 12+ equal nav items | `sidebar.tsx` `DEFAULT_GROUPS` L45–74 — Feed/Watchlist/Portfolio + Analysis + General |
| Scorecard Guide buried under General | `id: "scorecard-guide"` L70 — users don’t discover it |
| Auth identity for per-user persistence | `AuthContext.tsx` `AuthUser.id` L4–10; `useAuth` L48–50 |
| Settings Profile has no replay affordance | `settings.tsx` `ProfileTab` L40–69 — email/username/role only |
| localStorage pattern already used | `sidebar.tsx` `COLLAPSED_KEY` / `ORDER_KEY` L11–12, L114–124 |
| sessionStorage ≠ tour (must survive close) | `App.tsx` `useSessionState` L32–47 is for tickers — wrong store for tour |
| No ProductTour on disk | codegraph / grep: **zero** `ProductTour` / `data-tour-id` |
| Competitive gap | Parent research: TradingView progressive discovery; Robinhood first-path |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | `lib/tour-config.ts` — steps, version, read/write helpers |
| W2 | `ProductTourProvider` + `ProductTourOverlay` (custom portal; z-[100]) |
| W3 | 4 steps: `/` → `/options-scanner` → `/watchlist` → `/scorecard-explanation` |
| W4 | `data-tour-id` on sidebar items + one in-page anchor per step |
| W5 | Controls: Next, Back, Skip, Don’t show again; Escape = Skip |
| W6 | Auto-start once when `!completed && user && !isLoading` |
| W7 | Force sidebar expanded while tour active; restore prior collapse |
| W8 | Settings Profile → “Replay product tour” |

### Out of scope
| Item | Owner / reason |
|---|---|
| DB `users.tour_completed_at` | v2 multi-device |
| New npm tour library | Prefer Radix/dialog + CSS spotlight |
| Analytics events | No pipeline yet |
| Mobile-only layout | Desktop-first; don’t block ship |
| Rewriting home to “Today” | [seq 4](4-home-dashboard-redesign-070926.md) — bump `TOUR_VERSION` after |
| Inline score popovers | [seq 3](3-contextual-score-explanations-070926.md) — step 4 may say “Scoring Reference” |

### Tour steps (v1)

| Step | Route | Sidebar `data-tour-id` | In-page | Title |
|---|---|---|---|---|
| 1 | `/` | `fundamental` | `home-rankings` | Fundamental rankings |
| 2 | `/options-scanner` | `options-scanner` | `scanner-signals` | Options scanner |
| 3 | `/watchlist` | `watchlist` | `watchlist-view` | Watchlist deep dive |
| 4 | `/scorecard-explanation` | `scorecard-guide` | `guide-tabs` | Scoring reference |

Copy ≤2 sentences each; CSP-framed (put selling). If step 1 target missing after /4 layout change → fallback centered modal (already required).

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Nav IDs stable for anchors | `sidebar.tsx` L50–71: `fundamental`, `options-scanner`, `watchlist`, `scorecard-guide` |
| Auth gate | `App.tsx` `ProtectedRoute` L49–59; routes L68–107 |
| Provider mount point | `App.tsx` L113–127 — wrap inside `AuthProvider` (needs `user.id`) |
| ProfileTab insert point | `settings.tsx` L40–69 |
| Guide page exists | Route `/scorecard-explanation` L87–88; page has tabs (`setTab` L22) |
| Collapse key | `fildi_sidebar_collapsed` L11 |
| No tour code | Grep: no `ProductTour`, no `data-tour-id` |
| Lessons | `session-lesson-cursor.js grep` onboarding/tour — **none** |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/lib/tour-config.ts` | **New** — steps + storage |
| **P0** | `artifacts/stock-compare/src/components/product-tour/ProductTourProvider.tsx` | **New** |
| **P0** | `artifacts/stock-compare/src/components/product-tour/ProductTourOverlay.tsx` | **New** |
| **P0** | `artifacts/stock-compare/src/App.tsx` | Mount provider under AuthProvider |
| **P0** | `artifacts/stock-compare/src/components/sidebar.tsx` | `data-tour-id={item.id}`; honor `tourActive` expand |
| **P1** | `pages/home.tsx`, `options-scanner.tsx`, `watchlist.tsx`, `scorecard-explanation.tsx` | One in-page `data-tour-id` each |
| **P1** | `pages/settings.tsx` | Replay button in ProfileTab |
| **P2** | `.cursor/tasks/INDEX.md` | Mark done when shipped |

### 4.3 Read-not-modify

| Path | Why |
|---|---|
| `context/AuthContext.tsx` | `user.id` / `isLoading` contract |
| `pages/scorecard-explanation.tsx` | Step 4 destination; enh/20 may add `?tab=` — tour still lands on page |
| `components/ui/dialog.tsx` / `button.tsx` | Overlay chrome |
| Seq 3 / 4 task files | Cross-link only — don’t steal ExplainableScore or Today layout |

### 4.4 Persistence (paste-ready)

```typescript
const TOUR_KEY = (userId: number) => `fildi_tour_v1_${userId}`;
interface TourState {
  completed: boolean;
  skipped: boolean;
  completedAt?: string;
  version: 1; // bump after home redesign / major copy rewrite
}
```

### 4.5 Acceptance

- [ ] Cleared `fildi_tour_v1_*` → tour auto-starts after login on `/`
- [ ] Next through 4 steps changes routes; spotlight or fallback modal
- [ ] Don’t show again / Skip → no auto-restart on refresh
- [ ] Settings Replay restarts at step 1
- [ ] Collapsed sidebar expands during tour; restores after
- [ ] Missing `data-tour-id` → no crash
- [ ] `cd artifacts/stock-compare && npm run typecheck && npm run build`
- [ ] No API/DB/`.agents/` changes

### 4.6 Suggested commit message

`feat(ui): add first-run product tour with localStorage persistence`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| Auth + sidebar + guide page | Hard — exist |
| Seq 3 ExplainableScore | Soft — update step 4 copy when badges ship |
| Seq 4 Today home | Soft — bump `TOUR_VERSION` after layout change |
| enh/20 guide deep links | Soft — tour lands on guide; `?tab=` optional |

---

## 5. Impact & Risk

- Gate tour start on `!isLoading && user` — must not fire before auth resolves
- Route paint race needs retry measure (3x) or fallback modal
- Tour overlay needs `z-[100]` to sit above scanner expand
- Step 1 copy must track home title ("Fundamental Analysis" today → "Today" after seq 4) — single source in `tour-config.ts`

**Do not:** joyride package; DB column; Feed-as-step-1 (keep Fundamental/Today as CSP value prop).

---

## Review: APPROVE-WITH-NITS, applied in this pack — ready. Custom overlay; defer DB; coordinate `TOUR_VERSION` with seq 4 — do not wait on seq 4 to ship.
