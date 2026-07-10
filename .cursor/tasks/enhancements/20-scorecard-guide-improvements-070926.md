# scorecard-guide-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | S |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [contextual-score-explanations](../new_app_features/3-contextual-score-explanations-070926.md), [ai/11](../ai/11-product-ai-explain-csp-070926.md), [technical-scorecard](15-technical-scorecard-improvements-070926.md) |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Understand scoring math; tune weights to match your CSP strategy — faster presets + shareable anchors — without a second weight editor in Settings.

### Cache / DB compliance
Weights stay on `GET/PUT /api/scoring-config` via `ScoringPreferencesContext`. Presets = client apply of `ScoringWeightsConfig` then existing save/reset. No new API/cache. No PDF export. No Settings duplicate editor.

---

## 1. Executive summary (rescoped)

**Already present:**
- `/scorecard-explanation` — Fundamental / Technical / Options tabs + `GuideMetricGrid` (`scorecard-explanation.tsx`)
- Admin-only edit + Save / Reset defaults (L160–169)
- `buildDefaultScoringWeights()` uses `FAMILY_PRESETS.PUT_SELLER` (`scoring-weights.ts` L16–41)
- `FAMILY_PRESETS` already has `PUT_SELLER` + `GROWTH` (`rankings.ts` L128–132); `REGIME_PRESETS` exist for score-time regime (separate — don’t confuse)
- Sidebar link: Scorecard Guide (`sidebar.tsx`)
- **No** preset buttons, **no** URL hash anchors, **no** footer CTA to scanner
- Inline score popovers = [new_app_features/3](../new_app_features/3-contextual-score-explanations-070926.md) — deep-link *to* this guide from badges

**Do (Phase A):**
1. **Preset buttons** (admin draft path): Default (`buildDefaultScoringWeights` / PUT_SELLER), Aggressive income (boost optionStrike `income` + family tilt toward value/safety — document exact numbers in PR), Quality-first (family quality↑ growth↓ — or map to existing GROWTH inverse). Apply via `onDraftChange` / `setDraft`; still require Save
2. **Hash / anchors:** `?tab=technical` + element `id` on metric sections (e.g. `#metric-rsi` / row `key`) — `useEffect` scroll on load; shareable with new_app_features/3 links
3. **Footer:** “See scores on Scanner →” → `/options-scanner` (+ optional Home compare)

**Do not** move weight editor to Settings; do not add non-admin write without product decision (today edit is admin-only — presets follow same gate).

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Single weight editor | Only scorecard-explanation + ScoringPreferencesContext |
| Defaults exist | `buildDefaultScoringWeights` + `resetDefaults` |
| FAMILY_PRESETS partial | PUT_SELLER, GROWTH only — “Aggressive income” / “Quality-first” need explicit config objects |
| No hash routing | `useState("fundamental")` L22 — no `location.hash` |
| No scanner footer | Page ends at muted note L172–174 |
| Contextual task owns popovers | new_app_features/3 |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Preset chip row → sets `draft` to named `ScoringWeightsConfig` (validate with `validateScoringWeights`) |
| W2 | Export named presets from `scoring-weights.ts` (e.g. `SCORING_PRESETS`) |
| W3 | Sync tab from `?tab=` / `#` ; `id` on guide sections/rows for scroll |
| W4 | Footer link to scanner |
| W5 | Document deep-link format for new_app_features/3 (`/scorecard-explanation?tab=technical#oversoldDepth`) |

### Out of scope
| Item | Reason |
|---|---|
| Settings weight editor | Forbidden without consolidation plan |
| PDF export | Forbidden |
| Non-admin weight save | Keep current auth gate unless product changes |
| Second scoring-config API | Forbidden |
| Auto-apply REGIME_PRESETS on this page | Score-time concern — don’t conflate |

### Out of scope / pair
| Item | Owner |
|---|---|
| Inline badge → guide links | new_app_features/3 |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Page | `artifacts/stock-compare/src/pages/scorecard-explanation.tsx` |
| Config API | Context L20–64; DB `scoring-config-db.ts` |
| Validate sums | family 100; tech/option layers 1.0 — L60–70 |
| Guide rows | `scorecard-guide-metadata.ts` — `weightKey` / `key` for anchor ids |
| Route | App `/scorecard-explanation` |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/lib/scoring-weights.ts` | `SCORING_PRESETS` map + helpers |
| **P0** | `artifacts/stock-compare/src/pages/scorecard-explanation.tsx` | Preset UI; hash/tab sync; footer |
| **P1** | `guide-metric-grid.tsx` / metadata | Stable `id={row.key}` on rows if needed |
| — | Settings | Do not add editor |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `rankings.ts` FAMILY_PRESETS / REGIME_PRESETS | Reuse numbers; don’t fork regime auto-select here |
| new_app_features/3 | Consumer of deep links |
| ScoringPreferencesContext | Prefer extend via saveConfig only |

### 4.4 Paste-ready preset sketch

```ts
export const SCORING_PRESETS: Record<string, ScoringWeightsConfig> = {
  default: buildDefaultScoringWeights(),
  aggressiveIncome: {
    ...buildDefaultScoringWeights(),
    familyPreset: { value: 25, growth: 15, quality: 30, safety: 30 }, // sum 100 — tune in PR
    // optionally bump optionStrike.income and renormalize to 1.0
  },
  qualityFirst: {
    ...buildDefaultScoringWeights(),
    familyPreset: { value: 15, growth: 15, quality: 45, safety: 25 },
  },
};
// Always validateScoringWeights before setDraft
```

### 4.5 Deep-link contract

| URL | Behavior |
|---|---|
| `/scorecard-explanation?tab=technical` | Select Technical tab |
| `...#oversoldDepth` (or `#metric-oversoldDepth`) | Scroll to row after paint |
| Invalid tab/hash | Ignore; default fundamental |

### 4.6 Acceptance criteria

- [ ] Presets apply to draft and pass `validateScoringWeights`
- [ ] Save still required for persistence (admin)
- [ ] Reset defaults still works
- [ ] Tab query + hash scroll work
- [ ] Footer links to scanner
- [ ] No Settings weight editor
- [ ] No new scoring API
- [ ] stock-compare typecheck

### 4.7 Suggested commit message

`feat(scorecard-guide): weight presets, deep-link anchors, scanner footer`

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **new_app_features/3** | Soft — badge links consume anchors |
| ai/11 | Soft — explain copy points here |
| Admin auth | Hard for save — presets visible read-only to non-admin OK |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- scorecard-explanation + scoring-weights presets
- Rollback: revert; stored config unchanged until Save

### 2. Bug introductions
- Preset that fails validate → block apply + show error
- Hash scroll before tab mount → wait for TabsContent
- Non-admin clicking preset with no save — either hide presets or apply local-only session (prefer admin-only apply matching edit gate)
- Catch: Aggressive income → draft dirty → Save → reload weights match

### 3. Performance
- No new fetches

### 4. Workflow
- Learn weights → preset experiment → scanner

### 5. Drift
- Paired: guide anchors ↔ contextual popovers ↔ single ScoringPreferencesContext

**Do not:** Settings editor; PDF; REGIME_PRESETS auto on this page; second API.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Was:** draft. **Key:** presets via existing draft/save; anchors for contextual-score; no Settings fork.
