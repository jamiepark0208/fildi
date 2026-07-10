# macro-regime-tab-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | ui |
| **Effort** | M |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [macro-catalyst](11-macro-catalyst-calendar-improvements-070926.md), [daily-brief](9-portfolio-daily-brief-improvements-070926.md), [home](../new_app_features/4-home-dashboard-redesign-070926.md), [liquidity-money-flow-research](30-liquidity-money-flow-research-070926.md) (Net Liq / MMF story → **Liquidity** tab; Regime links, does not duplicate) |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Quick morning read on the Macro **Regime** tab: are financial conditions OK for selling premium today? Surface deltas + CSP income guidance from **cached** payloads — no new FRED storm.

### Cache / DB compliance
Derive from existing `GET /api/macro/data`, `/charts`, `/highlights`, `/regime`. **No** new TTLCache. **No** live FRED beyond existing routes. **No** Redis.

---

## 1. Executive summary (rescoped)

**Do not** add a new regime API or rebuild indicator history.

**Do** enhance the existing Regime tab (`RegimeBanner` + `MacroHighlightsPanel` + `RegimeChips` + charts):
1. **What-changed strip** — VIX / HY OAS / NFCI (and similar) Δ vs ~5 trading days from **charts cache** only
2. **CSP implication chip** — reuse `REGIME_INCOME_TARGET` / `REGIME_INCOME_FLOOR` from `@/lib/option-scorer-constants` (scanner already uses these)
3. **Events today** — already in highlights `EventsStrip`; add jump-to **Catalyst** tab
4. Link to portfolio brief when snapshot exists (enh/9)

**Naming caution:** two “regime” concepts exist — do not conflate:
- **VIX band** `MacroRegime` (`LOW_VOL|BASELINE|ELEVATED|EXTREME`) from `/api/macro/regime` — drives CSP income floors
- **RegimeBanner** expansion/contraction-style classifier (`regime-classifier` / banner meta) — broader macro narrative

CSP chip must use the **VIX-band** enum (same as scanner), not invent a third mapping.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Regime is default macro tab | `MACRO_TABS` — regime first |
| Stack already rich | `macro.tsx` L311–313: Banner + Highlights + Chips |
| eventsToday already shown | `MacroHighlightsPanel` → `EventsStrip` |
| Scanner has income constants | `option-scorer-constants.ts` `REGIME_INCOME_*` |
| No morning delta strip | Not present on Regime tab today |
| Charts have history series | `MacroCharts` — `vixHistory`, `hySpreadHistory`, `nfciHistory`, `dxyHistory`, … |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Morning delta strip under banner: compute last vs ~5d-ago from chart arrays already fetched |
| W2 | CSP target/floor chip from VIX-band regime + `REGIME_INCOME_*` |
| W3 | Events pills → `setActiveTab("catalyst")` (or equivalent) |
| W4 | Optional: “Portfolio brief” → `/portfolio` if snapshot (enh/9) |
| W5 | Copy: one-line CSP implication under banner |

### Out of scope
| Item | Reason |
|---|---|
| New FRED / regime API | Forbidden |
| Duplicating RegimeBanner on home | home task owns home strip |
| Second highlights AI | Forbidden |
| Redis | Forbidden |
| Rebuilding indicator-history fetch | Out of scope |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Regime tab composition | `macro.tsx` imports RegimeBanner, MacroHighlightsPanel, RegimeChips |
| MacroCharts fields | `macro-page-types.ts` L80–97 — histories for VIX, HY, NFCI, DXY, … |
| VIX-band API | `macro-regime.ts` — 30m cache; Yahoo quotes |
| Income constants | `REGIME_INCOME_TARGET` / `FLOOR` in `option-scorer-constants.ts`; used in scanner L671–672 |
| Highlights events | `macro-highlights.ts` L158–159; panel L290 |
| Catalyst tab id | `MacroTab = … \| "catalyst"` |

### 4.2 Files to modify (authoritative)

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/macro.tsx` (regime branch) | Mount delta strip + CSP chip; wire tab jump |
| **P0** | `artifacts/stock-compare/src/components/macro/` (new small component OK) | `MorningDeltaStrip` — pure function over `MacroCharts` |
| **P1** | `RegimeBanner.tsx` or adjacent | CSP one-liner / chip; avoid bloating banner if cleaner as sibling |
| **P1** | Link to portfolio | If snapshot query cheap — reuse react-query key from portfolio |
| — | `macro-data.ts` / FRED fetchers | **No** new series for this task |
| — | `macro-regime.ts` | Prefer no change |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `option-scorer-constants.ts` | Import floors/targets — single SSOT |
| `MacroHighlightsPanel.tsx` | Events already rendered — enhance navigation only |
| `regime-classifier.ts` | Banner regime ≠ VIX band |
| home redesign task | Don’t duplicate home strip here |

### 4.4 Delta algorithm (spec)

```
given charts.vixHistory (sorted by date ascending):
  last = history.at(-1)
  ago = point with date <= last.date - 5 calendar days (or 5 points back if sparse)
  delta = last.value - ago.value
  deltaPct = ago.value ? delta / ago.value : null
same for hySpreadHistory, nfciHistory (and optionally dxyHistory)
if series length < 2: show "—"
never: fetch FRED from the strip component
```

### 4.5 Acceptance criteria

- [ ] Delta strip renders from already-loaded `/api/macro/charts` (or parent props) — no extra FRED
- [ ] CSP chip numbers match scanner’s `REGIME_INCOME_*` for same VIX-band regime
- [ ] Clicking today’s event control switches to Catalyst tab
- [ ] Does not add RegimeBanner clone to every page
- [ ] stock-compare typecheck

### 4.6 Suggested commit message

`feat(macro): regime morning deltas and CSP income chip`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **enh/11** | Events → Catalyst tab |
| **enh/9** | Portfolio brief link |
| new_app_features/4 | Home strip — don’t steal |

---

## 5. Data note
All reads from existing macro caches/files. Classifier vs VIX-band documented in UI copy if both shown.

## 6. Impact & Risk Analysis

### 1. Blast radius
- macro.tsx regime section + small components
- Rollback: remove strip/chip

### 2. Bug introductions
- Mapping expansion-regime → income floors wrongly — **use VIX-band only**
- Sparse history → NaN — guard length
- Catch: load Regime tab offline-ish with cached charts; deltas sane

### 3. Performance
- Client-only math on arrays already in memory

### 4. Workflow
- Before: charts without “what changed”  
- After: morning strip + CSP guidance  

### 5. Drift
- Paired: `REGIME_INCOME_*` ↔ scanner ↔ this chip

### 6. Scalability
- Add series to strip only if already in MacroCharts

**Do not:** new FRED; Redis; second highlights AI; conflate regime enums.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Was:** draft. **Key:** two regime enums — CSP chip = VIX-band + existing income constants.
