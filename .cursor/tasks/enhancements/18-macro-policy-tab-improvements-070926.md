# macro-policy-tab-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | ui |
| **Effort** | S |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [macro-regime](10-macro-regime-tab-improvements-070926.md), [macro-catalyst](11-macro-catalyst-calendar-improvements-070926.md), [macro-volatility](17-macro-volatility-tab-improvements-070926.md) |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Rates/Fed path risk — will policy blow up short puts? Answer “size down?” without reading every bank card and SEP cell.

### Cache / DB compliance
Reuse existing queries: `/api/macro/charts` (fedFundsCurve), `/api/macro/fed-members`, `/api/macro/events`, `/api/macro/bank-research`, SEP endpoints already wired in `macro.tsx`. Keep Infinity / long staleTimes. **No** new SEP API, live Fed wire, Redis, or second `bank-research/generate` path (admin Refresh Stances stays as-is).

---

## 1. Executive summary (rescoped)

**Already present (do not rebuild):**
- Policy tab (`macro.tsx` L524–635): FedFundsCurveChart + history, SEP table + `SepDotsChart`, Bank Research grid (`BankCard`), Fed Members (`FedStanceGroup`)
- `BankCard` already collapses **news** until expand (`MacroComponents.tsx` L1053+) — but **all bank cards show full summary** in a 2×4 grid (dense)
- `thisWeekEvents` / FOMC-ish events already computed (L196–199) but rendered on **Catalyst** tab (L681+), not Policy

**Do (Phase A — copy + density only):**
1. **CSP so-what strip** at top of Policy — 3 bullets derived client-side from existing payloads (no new API):
   - Rates direction (front of `fedFundsCurve` implied path vs spot / weekAgo)
   - Next FOMC / high-importance event from `events` (filter name/importance — reuse same list as catalyst)
   - Vol implication one-liner (tie to VIX level from `macroData` already on page — “elevated VIX → richer premium / wider stops” style; **do not** invent a third regime classifier — point to Regime tab / VIX-band language from enh/10)
2. **Collapse bank research by default** — show compact row (shortName + stance + rateView); expand for summary + news (tighten `BankCard` default collapsed body)
3. Link: “See regime implications →” switches to Regime tab (`setActiveTab("regime")` or `?tab=regime`)

**Do not** add live Fed wire, new generate endpoint, or duplicate SEP fetch.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Policy is data-rich, low “so what” | L524–635 — charts/tables first; no CSP summary |
| Events unused on Policy | `thisWeekEvents` only under catalyst L681 |
| Bank density | L608–611 grid of full `BankCard`s |
| Generate path exists | `generateBankMutation` L182–185 — admin only; keep single path |
| Regime link missing | No cross-tab CTA on Policy |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | `PolicyCspSummary` component — 3 bullets from curve + events + vix (props from parent) |
| W2 | `BankCard`: default collapsed to header metrics; click expands summary (news already gated) |
| W3 | Button/link to Regime tab |
| W4 | Optional: pin next FOMC `EventRow` under summary (reuse component) |

### Out of scope
| Item | Reason |
|---|---|
| Live Fed / new SEP API | Forbidden |
| Second bank-research generate | Forbidden |
| Redis | Forbidden |
| Rewriting Fed member cards | Out of scope |
| New regime classifier | Use enh/10 VIX-band language only |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Policy tab block | `macro.tsx` L524–635 |
| Fed curve type | `FedFundsCurvePoint` — `impliedRate`, `weekAgo`, `meetingDate` |
| BankCard expand | L1053–1156 — `isExpanded` gates news only; summary always `line-clamp-3` |
| Events query | L116–120 `staleTime: Infinity` |
| Related packs | enh/10 regime; enh/11 catalyst calendar |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/macro.tsx` | Insert summary; regime link; pass props |
| **P0** | `artifacts/stock-compare/src/components/macro/MacroComponents.tsx` | `BankCard` denser default; optional `PolicyCspSummary` |
| — | API routes | Prefer no change |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| enh/10 pack | VIX-band vs banner classifier |
| enh/11 | Events ownership on catalyst |
| `macro-page-types.ts` | Types already sufficient |

### 4.4 Paste-ready summary rules (client)

```ts
// Pseudo — implement with null-safe copy
// 1) Rates: compare first non-null fedFundsCurve.impliedRate to weekAgo → "markets price cuts/hikes"
// 2) Next event: first thisWeekEvents with importance==="high" or name match /FOMC|CPI|NFP/i
// 3) Vol: macroData.vix.level → map to CSP sizing hint; link Regime for income floors
```

### 4.5 Acceptance criteria

- [ ] Policy tab shows 3-bullet CSP summary from existing data only
- [ ] Bank cards collapsed by default (summary not fully expanded)
- [ ] Link reaches Regime tab
- [ ] No new macro API / generate path / Redis
- [ ] stock-compare typecheck

### 4.6 Suggested commit message

`feat(macro): CSP policy summary and denser bank research cards`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| enh/10 | Soft — copy alignment for vol/regime language |
| enh/11 | Soft — events list shared |
| enh/17 | Soft — `?tab=` parsing if added there first |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- macro.tsx Policy section + BankCard
- Rollback: revert UI

### 2. Bug introductions
- Overconfident “size down” copy from thin curve data — keep hedging language (“markets imply…”)
- Collapsing BankCard hides summary users relied on — ensure one-click expand obvious
- Catch: Policy top shows 3 bullets; bank grid headers only until click

### 3. Performance
- No new fetches

### 4. Workflow
- Morning policy skim → size CSP → optional Regime/Catalyst drill

### 5. Drift
- Paired: Policy summary ↔ Regime CSP chip ↔ Catalyst events

**Do not:** Fed wire; second generate; Redis; third regime enum.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Was:** draft. **Key:** data already loaded — add CSP strip + denser BankCard; no new APIs.
