# settings-trader-preferences-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | ui |
| **Effort** | M |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [scorecard-guide](20-scorecard-guide-improvements-070926.md), [daily-brief](9-portfolio-daily-brief-improvements-070926.md), [scanner-simplified](../new_app_features/5-scanner-simplified-view-070926.md), [watchlist-monitor](16-watchlist-monitor-improvements-070926.md) |
| **Type** | NEW (Trading tab) + ENHANCE (wire prefs) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Personalize CSP workflow — default scanner filters and brief-related prefs — without admin ops tabs or a second weight editor.

### Cache / DB compliance
Scanner defaults = **localStorage** (scoped by userId like watchlist colors). Brief tone/strategy fields = existing `GET|PATCH /api/daily-brief/context` (**PATCH is admin-only today** — see W3). No new TTLCache. No job-queue / alert workers. No Redis. Weights stay on Scorecard Guide only.

---

## 1. Executive summary (rescoped)

**Already present:**
- `/settings` tabs: Profile (all users); Users / Cache / Stock DB / API Monitor (**adminOnly**) — `settings.tsx` L490–543
- ProfileTab = email/username/role only (L40–70)
- Scanner: `minIncome` is `useState(0.5)` — **not** persisted (`options-scanner.tsx` L695–696); only `fildi_scanner_extra` / `fildi_scanner_hidden` use localStorage
- Weights: Scorecard Guide + `ScoringPreferencesContext` — **do not duplicate**
- Brief context: `GET /daily-brief/context`; **`PATCH` requires `requireAdmin`** (`daily-brief.ts` L278–284) — file-backed `brief-context.json`

**Do (Phase A):**
1. Add **Trading** tab visible to all authenticated users
2. Persist default **min weekly income** (+ optional default color-filter hint) in `fildi_trader_prefs_{userId}` localStorage
3. Wire scanner to **read** that key on mount (replace hard-coded 0.5)
4. Link row: “Edit score weights → Scorecard Guide” (`/scorecard-explanation`)
5. Brief prefs: **read-only** display of context for non-admin; admin can PATCH from Trading tab **or** keep editor on portfolio (enh/9) — pick one surface in PR (prefer: link to portfolio brief editor for admin; Trading shows “managed on Portfolio” to avoid dual editors)
6. Alert prefs = **disabled stub** (“Coming when job-queue approved”) — no workers

**Do not** put weight sliders in Settings; do not change admin cache/Stock DB.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Non-admin has nowhere for trading prefs | Settings tabs filter `adminOnly` L504 |
| minIncome resets every visit | L695 `useState(0.5)` — no localStorage |
| Extra/hidden tickers already persist | L699–707 |
| Brief context PATCH admin-only | daily-brief.ts L283–284 |
| Weights elsewhere | enh/20 + scorecard-explanation |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | `TradingTab` in settings.tsx — non-admin visible |
| W2 | Prefs type + load/save helpers (user-scoped localStorage) |
| W3 | options-scanner: init `minIncome` from prefs; optional “Save as default” on scanner filter UI |
| W4 | Link to Scorecard Guide; optional link to Portfolio for brief context |
| W5 | Alert prefs stub (disabled toggles + copy) |

### Out of scope
| Item | Reason |
|---|---|
| Weight editor in Settings | Forbidden (enh/20) |
| Background alert workers | Forbidden until job-queue |
| Redis / admin cache changes | Forbidden |
| Opening PATCH context to all users | Product decision — default keep admin-only; don’t silently widen |
| New prefs API / table | localStorage v1 |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Settings tabs | `settings.tsx` L490–543 |
| Scanner minIncome | L695–696, UI L1110+ |
| Brief API | GET L278; PATCH + requireAdmin L283–284 |
| enh/9 note | Context is PATCH not POST |
| Color tags | `PRESET_COLORS` in use-watchlist — default filter color optional |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/settings.tsx` | Trading tab |
| **P0** | `artifacts/stock-compare/src/pages/options-scanner.tsx` | Read/write default minIncome |
| **P1** | Optional `lib/trader-prefs.ts` | Typed get/set |
| — | `routes/daily-brief.ts` | Prefer no change in Phase A |
| — | Scorecard / scoring-config | Do not touch |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| enh/9, enh/20 | Ownership of brief UI / weights |
| new_app_features/5 | Future filter key names — align when that ships |
| ApiMonitorTab / CacheMonitor | Admin-only |

### 4.4 Paste-ready prefs shape

```ts
type TraderPrefs = {
  minWeeklyIncome: number;      // default 0.5
  defaultColorFilter: string | null; // watchlist filter hex or null
};
function prefsKey(userId?: number) {
  return userId ? `fildi_trader_prefs_${userId}` : "fildi_trader_prefs";
}
```

### 4.5 Acceptance criteria

- [ ] Non-admin sees Trading tab; does not see admin tabs
- [ ] minIncome default survives reload via localStorage
- [ ] Scanner initializes from prefs
- [ ] Link to Scorecard Guide present
- [ ] No weight editor in Settings
- [ ] No alert workers / new APIs
- [ ] Brief PATCH auth unchanged unless explicit product change
- [ ] stock-compare typecheck

### 4.6 Suggested commit message

`feat(settings): Trading prefs tab for scanner defaults`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| enh/20 | Soft — Guide link target |
| enh/9 | Soft — brief editor ownership |
| new_app_features/5 | Soft — filter key names |

---

## 5. Impact & Risk Analysis

- Avoid dual brief editors if Trading tab also PATCHes — keep a single edit surface
- localStorage prefs must be scoped by userId to avoid cross-user clobber
- Validate minIncome ≥ 0 before persisting

**Do not:** Settings weights; Redis; alert workers; widen brief PATCH silently.

---

## Review: APPROVE — ready. minIncome not persisted today; Trading tab = localStorage + Guide link; brief stays admin PATCH.
