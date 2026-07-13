# macro-volatility-tab-improvements

| Field | Value |
|---|---|
| **Status** | done — Volatility tab shipped 2026-07-13 (Volatility Regime Read implication card: VIX level, term structure, VVIX, put/call, HY credit cross-check, MOVE index → overall verdict; new MOVE index fetch/chart; /sentiment redirects to /macro?tab=volatility since ExtremesTable was already redundant with CotSection's inline extremes table) |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [macro-regime-tab](10-macro-regime-tab-improvements-070926.md), [social-sentiment-polish](../new_app_features/9-social-sentiment-polish-070926.md) |
| **Type** | FIX + ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
One place for vol regime + positioning extremes — know if premium is rich and crowding is dangerous — without an orphan COT page.

### Cache / DB compliance
Reuse `GET /api/cot/summary` + `/api/cot/history` (React Query keys `cot-summary` / `cot-history`). Macro charts/VIX already on volatility tab. Consolidate UI consumers — **do not** add parallel COT TTLCache or new CFTC scraper. No Redis. No cron alerts.

---

## 1. Executive summary (rescoped)

**Already present:**
- Macro tab **Volatility & Sentiment** (`macro.tsx` L472+): VIX/SKEW/VXN, VIX curve/history, Fear&Greed, VVIX, equity put/call, **CotSection** for non-macro instruments (`sentCoTs` L251–252, L510–518)
- Regime tab: CotSection for `COT_MACRO_IDS` = sp500, nasdaq100, tbonds (L72, L459+)
- Full COT UX on **orphan** `/sentiment` (`sentiment.tsx`): SummaryCards, HistoryChart, CategoryBreakdown, **ExtremesTable** with z-scores — route in `App.tsx` L105–107
- **Not in sidebar** — no `sentiment` nav item (`sidebar.tsx` grep empty)

**Do (Phase A):**
1. **Extract** shared COT widgets from `sentiment.tsx` into `components/macro/` (or reuse if `CotSection` already covers enough — audit gap: ExtremesTable + full instrument grid vs CotSection)
2. Embed **ExtremesTable** (and richer detail if CotSection lacks it) on Volatility tab below existing CotSection
3. **Redirect** `/sentiment` → `/macro` with volatility tab selected (e.g. `?tab=volatility` or existing tab state mechanism)
4. Remove duplicate page once redirect works; keep API unchanged
5. Optional: one-line link from vol summary to scanner regime banner copy (no second classifier — see enh/10)

**Do not** rebuild VIX charts or add a second COT fetch path.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Orphan route | `App.tsx` L105–107 `/sentiment`; sidebar has no entry |
| Full COT UI only on sentiment | ExtremesTable L241–297; SummaryCard grid L360–370 |
| Macro already fetches cot-summary | `macro.tsx` queryKey `["cot-summary"]` L153; filters macro vs sent L251–252 |
| Volatility has partial COT | CotSection for `sentCoTs` only L510–518 — no ExtremesTable |
| Regime has equity/bond COT | macroCoTs CotSection L459+ |
| Duplicate page risk | Two UIs over same APIs |

---

## 3. What (build scope)

### Phase A — in scope
| # | Work |
|---|---|
| A1 | Diff `CotSection` vs sentiment widgets — extract ExtremesTable (+ SummaryCard grid if CotSection is thinner) to shared module |
| A2 | Mount ExtremesTable on Volatility tab; selecting row sets `selectedSentCotId` (already state L87) |
| A3 | Redirect `/sentiment` → `/macro?tab=volatility` (or hash); ensure Macro reads tab from query on load |
| A4 | Delete or thin `sentiment.tsx` to redirect-only; drop Sidebar if any deep links |
| A5 | Optional: “Open scanner” text linking regime/vol context — copy only, no new API |

### Out of scope
| Item | Reason |
|---|---|
| New CFTC / COT source | Forbidden |
| Parallel COT cache | Forbidden |
| Rebuild VIX / Fear&Greed charts | Forbidden |
| Extreme positioning cron alerts | v2 — no workers |
| Social sentiment (Twitter etc.) | new_app_features/9 — different product |
| Changing Regime COT section | Leave macroCoTs on regime unless merge explicitly desired |

### v2
| Item | Note |
|---|---|
| Extreme z-score alerts | Prefs stub only after job-queue |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| MacroTab includes `"volatility"` | `macro-page-types.ts` L154–158 |
| COT_MACRO_IDS | L164 / macro.tsx L72 — sp500, nasdaq100, tbonds |
| Sentiment page fetch | `/api/cot/summary`, `/api/cot/history?instrument=` L304–314 |
| zBadge / ExtremesTable | sentiment.tsx L241+ |
| CotSection import | macro.tsx from MacroComponents |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/macro.tsx` | Embed ExtremesTable; tab from `?tab=` |
| **P0** | `artifacts/stock-compare/src/pages/sentiment.tsx` | Redirect → macro volatility |
| **P0** | `artifacts/stock-compare/src/App.tsx` | Keep route for redirect **or** inline Redirect |
| **P1** | `components/macro/MacroComponents.tsx` (or new file) | Move ExtremesTable / shared COT pieces from sentiment |
| **P1** | `macro-page-types.ts` | Export shared types if not already |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `api-server` cot-data / routes | Prefer no API change |
| enh/10 regime tab pack | Classifier vs chip copy — don’t fork |
| new_app_features/9 | Social polish ≠ COT |

### 4.4 Redirect contract

| From | To |
|---|---|
| `/sentiment` | `/macro?tab=volatility` |
| Bookmarks | Must land on Volatility with COT visible |

Macro already has `activeTab` state — wire initial from `URLSearchParams.get("tab")` if valid `MacroTab`.

### 4.5 Acceptance criteria

- [ ] `/sentiment` redirects to macro Volatility
- [ ] ExtremesTable (z-score ranking) visible on Volatility without visiting orphan page
- [ ] Same `cot-summary` / `cot-history` queries — no second fetch library
- [ ] No new CFTC scraper / TTLCache
- [ ] Sidebar unchanged (still no orphan link) or points to macro
- [ ] stock-compare typecheck
- [ ] Manual: click extreme row → history updates (existing selectedSentCotId behavior)

### 4.6 Suggested commit message

`fix(macro): fold COT extremes into Volatility tab; redirect /sentiment`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| enh/10 | Regime tab — leave equity COT there unless product wants single COT home |
| new_app_features/9 | Name collision “sentiment” — different feature |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- macro.tsx, sentiment.tsx, App route, shared macro components
- Rollback: restore sentiment page; remove Extremes from volatility

### 2. Bug introductions
- Redirect loses instrument selection — acceptable; default gold/sp500 as today
- Double CotSection + Extremes clutter — place Extremes below; don’t duplicate SummaryCard grid if CotSection already lists instruments
- `?tab=` ignored → users land on Regime — must parse query
- Catch: open `/sentiment` → Volatility; ExtremesTable sorts by \|z\|

### 3. Performance
- Same queries as today when tab open; avoid fetching cot-history until instrument selected (already `enabled`)

### 4. Workflow
- Vol + crowding in one tab for CSP premium timing

### 5. Drift
- Paired: delete orphan ↔ single COT UI path ↔ enh/10 regime COT subset

**Do not:** second COT cache; new scraper; cron alerts; confuse with social sentiment task.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Was:** draft. **Key:** `/sentiment` is orphan with ExtremesTable; Volatility already has CotSection + cot-summary — fold extremes in and redirect.
