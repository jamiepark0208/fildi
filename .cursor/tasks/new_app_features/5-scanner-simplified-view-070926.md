# scanner-simplified-view

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M |
| **Created** | 2026-07-09 |
| **Source** | competitive-research |
| **Research** | [feature-purpose-research](../enhancements/1-feature-purpose-research-070926.md) |
| **Related** | [home-dashboard](4-home-dashboard-redesign-070926.md), [todays-top-picks](6-todays-top-picks-feed-070926.md), [settings-trader-prefs](../enhancements/21-settings-trader-preferences-improvements-070926.md), [technical-scorecard](../enhancements/15-technical-scorecard-improvements-070926.md) |
| **Type** | ENHANCE (presentation toggle — not new scorer) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Pick strike/expiry with confidence on watchlist names — Simple cards for GO/WATCH triage; Advanced keeps the dense strike grid.

### Cache / DB compliance
No new options/Yahoo paths. Reuse existing scanner React Query keys (`technical-scorecard`, `technicals/all`, per-ticker `options`, regime). Options chains stay **lazy on expand**. Extract `buildReasoning` once to `lib/scanner-reasoning.ts` (shared with seq 4 + 6). No Redis.

---

## 1. Executive summary (rescoped)

**Already present (do not rebuild):**
- Full Advanced UI = current `OptionsScanner` + `ScannerRow` + `ExpirySection` / 9-col strike table
- `buildReasoning()` at `options-scanner.tsx` L123–143 — **only rendered when row expanded** (L573–576)
- `SignalBadge`, `viableStrikes`, `pickBestStrike` / `newScorerBest`, `minIncome`, regime query
- localStorage patterns: `fildi_scanner_extra`, `fildi_scanner_hidden` (not view mode yet)

**Do:**
1. Simple \| Advanced toggle — persist `fildi_scanner_view` (default **Simple**)
2. `ScannerSimpleCard` — signal, tech score, IV, best %/wk or “Open to load strikes”, **headline `buildReasoning` always visible**
3. Extract `buildReasoning` → `lib/scanner-reasoning.ts` **first** (unblocks home/4 + picks/6)
4. Simple sort: GO → WATCH → NO; within band by tech/stock score desc
5. Filter chips: GO only + existing minIncome (wire to enh/21 default when that ships)
6. Expand still uses existing `expandedSet` + options fetch — do not prefetch all chains in Simple

**Do not:** rewrite option scorer; delete Advanced; new API; mobile-only layout.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Reasoning buried | `buildReasoning` L123–143; UI only inside expanded panel L573–576 |
| Dense Advanced is default | Strike table `grid-cols-[80px_56px_72px…]` ~L198 — no Simple mode |
| No view persistence | Grep: no `fildi_scanner_view` (only `fildi_scanner_extra` / `_hidden` L699–707) |
| Shared extract needed | home/4 + picks/6 both require same lib |
| Competitor | Barchart/OptionStrat lead with ranked simple cards |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Extract `buildReasoning` (+ types) to `lib/scanner-reasoning.ts`; scanner imports it |
| W2 | `ScannerViewToggle` + localStorage `fildi_scanner_view` |
| W3 | `ScannerSimpleCard` / list — presentational from same props as `ScannerRow` header |
| W4 | Simple sort + GO-only chip |
| W5 | Empty states (“No GO signals — lower min income or open Advanced”) |
| W6 | Respect same scorer path as Advanced (`newScorerBest` when flag on) |

### Out of scope
| Item | Reason |
|---|---|
| New scorer / API | Forbidden |
| Prefetch all option chains | Rate-limit risk |
| Delete Advanced | Toggle only |
| Duplicate minIncome prefs UI | enh/21 owns Settings Trading tab |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| `buildReasoning` | L123–143 |
| Rendered only when expanded | L573–576 |
| `ScannerRow` | ~L415+; expand ~L498–564 |
| `viableStrikes` / strike summary | ~L95–121 |
| `minIncome` state | ~L695–696 (not prefs-persisted — enh/21) |
| localStorage extras/hidden | L699–707 |
| Page export | `OptionsScanner` ~L685 |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/lib/scanner-reasoning.ts` | **New** — extract |
| **P0** | `artifacts/stock-compare/src/pages/options-scanner.tsx` | Import; toggle; Simple list |
| **P1** | `components/scanner/ScannerSimpleCard.tsx` | Optional split if file size hurts |
| — | API routes | Prefer no change |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| seq 4, 6 packs | Shared extract consumers |
| enh/15 | Scanner `?ticker=` deep-link — keep working |
| enh/21 | Default minIncome |

### 4.4 Paste-ready extract

```ts
// lib/scanner-reasoning.ts — move body from options-scanner L123–143 unchanged
export function buildReasoning(
  d: Pick<ScorecardRow, "signal" | "rsi" | "rsiThreshold" | "mfi" | "mfiOk" | "rsiOk" | "return5d" | "vsSpy20d" | "ivCurrent">,
  firstIV: number | null,
  macroRegime: MacroRegime = "BASELINE",
): string { /* … */ }
```

### 4.5 Acceptance criteria

- [ ] First visit defaults to Simple; toggle persists
- [ ] Advanced pixel-parity with today’s UI
- [ ] Simple shows reasoning without expand
- [ ] Expand still lazy-loads options
- [ ] `lib/scanner-reasoning.ts` imported by scanner (home/picks can follow)
- [ ] No new API / no all-chain prefetch
- [ ] stock-compare typecheck

### 4.6 Suggested commit message

`feat(scanner): Simple view with shared buildReasoning extract`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **seq 4 / 6** | Soft — extract first unblocks them |
| enh/21 | Soft — minIncome default |
| enh/15 | Soft — `?ticker=` focus |

---

## 5. Impact & Risk Analysis

- `options-scanner.tsx` is large — grep before editing, prefer extract + thin toggle over inline changes
- Card click vs expand/refresh needs `stopPropagation` on action buttons
- Simple-view sort diverging from Advanced needs explicit documentation
- Paired with `scanner-reasoning.ts` ↔ home FeaturedPick ↔ top picks — keep in sync

**Do not:** delete Advanced; new scorer; prefetch chains.

---

## Review: APPROVE — ready. Reasoning exists but only on expand — Simple surfaces it; extract lib first for seq 4/6.
