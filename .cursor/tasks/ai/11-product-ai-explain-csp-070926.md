# product-ai-explain-csp

| Field | Value |
|---|---|
| **Status** | unblocked — ready to build (dep naf/3 ✅ done 2026-07-10) |
| **Priority** | P0 |
| **Area** | ui |
| **Effort** | M (~1 session **after** new_app_features/3 ships shared hook/component; longer if merged) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floors **R3**, **R4**, **R8**, **R9**, **R10** |
| **Related** | [contextual-score-explanations](../new_app_features/3-contextual-score-explanations-070926.md) (**hard dep**), [scanner-simplified-view](../new_app_features/5-scanner-simplified-view-070926.md), [home-dashboard-redesign](../new_app_features/4-home-dashboard-redesign-070926.md) |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — product UI; prefer **no** API change |

## ✅ UNBLOCKED — 2026-07-10 (dep naf/3 shipped)

**What naf/3 delivered (do not re-implement):**
- `stock-compare/src/components/ExplainableScore.tsx` — popover component wrapping any score chip
- `stock-compare/src/hooks/useScoreExplanation.ts` — shared hook with module-level memCache; calls `POST /api/explain/score`; server now checks `explain_cache` DB table before Haiku (so second click is instant)
- `stock-compare/src/lib/score-summary-copy.ts` — static one-liners per scoreType
- `api-server/src/routes/explain.ts` — updated: cache-first, upserts on miss, PROMPT_VERSION="v2" in hash

**What ai/11 still needs to build (scanner surface):**
- Wire `ExplainableScore` into the options-scanner expanded panel (under `buildReasoning` line, L573+)
- Map scanner row data → `technicalData` payload (mirror `technical.tsx` `buildTechnicalPayload` — it's already extracted as a module-level function there, read it before building)
- `stopPropagation` on the Explain more button so it doesn't toggle the row
- Only show "Explain more" if the technical payload can be fully built from the row; otherwise show a CTA link to the Technical Scorecard

### Purpose
Traders understand **why** a CSP setup / score reads GO-WATCH-NO without leaving the card — AI narrates trusted numbers; it never replaces them.

### Cache / DB compliance
Reuse `POST /api/explain/score` only. Cache AI text in **sessionStorage**. Click-only. No Redis. No second explain route. Deterministic `buildReasoning()` remains the signal one-liner.

---

## 1. Executive summary (rescoped)

**Do not** invent `/api/explain/csp` or auto-fetch Haiku on row expand.

**Do** wire CSP surfaces (scanner row first; home/scanner-simple when those tasks land) to the **shared** `ExplainableScore` + `useScoreExplanation` owned by [new_app_features/3](../new_app_features/3-contextual-score-explanations-070926.md). Keep `buildReasoning()` visible above any AI text. Extract `buildReasoning` only if a second consumer needs it.

**Blocked until:** `ExplainableScore` / `useScoreExplanation` exist (confirmed **absent** on disk 2026-07-09) — either sequence after /3 or merge scopes in one PR with clear ownership.

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| Plain-language “so what” for puts | User problem / research | Numbers alone insufficient |
| Reuse Haiku explain investment | explain.ts exists | R3 — same route |
| Click-only | R8/R9; generalLimiter | No hover/open auto-fetch |
| Deterministic signal line stays | R4 | `buildReasoning` never replaced by LLM |
| Share component with leaderboards | new_app_features/3 | Avoid third Why implementation |
| sessionStorage cache | /3 + project notes | In-memory Map today on leaderboards — upgrade via shared hook |

---

## 3. What (build scope — after research)

### In scope (this task — CSP surfaces)
| # | Work |
|---|---|
| W1 | Scanner expanded panel: keep `buildReasoning` line; add ExplainableScore / “Explain more” for **technical** when payload available |
| W2 | Use shared `useScoreExplanation` (sessionStorage) — **delete** any new local fetch Map if introduced |
| W3 | Label AI as narrative — not advice; scores + buildReasoning remain truth |
| W4 | Cache key includes ticker + scoreType + score identity (see §4.4) |
| W5 | Soft: home / scanner-simple cards when those pages exist — same pattern |

### Owned by new_app_features/3 (do not re-implement here)
| Item | Notes |
|---|---|
| `ExplainableScore.tsx`, `useScoreExplanation.ts`, `score-summary-copy.ts` | Create in /3 |
| Refactor rankings-leaderboard + technical.tsx Why | Extract duplicate fetch into hook |
| Guide deep link / Scoring Reference label | /3 |

### Out of scope
| Item | Reason |
|---|---|
| New `/api/explain/csp` | R3 |
| Auto-fetch on hover/expand | Cost |
| LLM rewriting signal or option score | R4 |
| Option-score / stock-score Haiku v1 | API only supports `fundamental` \| `technical` |
| Replacing buildReasoning with LLM | Hard ban |
| Redis / server explain cache | sessionStorage v1 |

---

## 4. Implementation research pack (for next coding agent)

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Explain API exists | `artifacts/api-server/src/routes/explain.ts` — `POST /explain/score` L119 |
| scoreType union | `"fundamental" \| "technical"` only — L48 |
| Haiku + max_tokens 200 | L136–139; model `claude-haiku-4-5-20251001` |
| Errors soft-fail | catch → `{ explanation: "Unable to generate…" }` L144–146 — **not** hard 500 |
| buildReasoning exists | `options-scanner.tsx` L123–143; rendered L573–576 when `indicator` present |
| buildReasoning callers | **1** (same file) — extract only when second consumer needs it |
| ExplainableScore / hook / score-summary-copy | **Missing on disk** (`ls` → NO) |
| scanner-reasoning.ts | **Missing** |
| Existing Why UIs (in-memory Map, no sessionStorage) | `rankings-leaderboard.tsx` L60–85 (fundamental payload); `technical.tsx` ~L325 |
| Strike panel “Why this strike” | `strike-detail-panel.tsx` L395 — **deterministic analysis**, not Haiku — do not confuse |
| home.tsx explain | No `buildReasoning` / explain/score usage found |

### 4.2 Payload reality for scanner CSP

Explain API **technical** needs `TechnicalData` (totalScore, rank, signal, regime, componentScores, rsi14, …) — see explain.ts L23–44.

Scanner row today has `indicator: ScorecardRow`, `score: TechnicalScore`, `techRow` — **not** automatically the explain payload shape.

**Implementer must:**
1. Map scanner/tech scorecard fields → `technicalData` (mirror `technical.tsx` `fetchExplanation` body — **read that function** when building; do not invent fields)
2. If mapping incomplete → show static ExplainableScore / “Open technical scorecard for AI explain” — **never** POST partial junk or hallucinate metrics
3. Fundamental explain on scanner only if fund payload is actually on the card; else link out

### 4.3 Files to modify (when unblocked)

| Priority | Path | Change |
|---|---|---|
| **Dep** | Per [new_app_features/3](../new_app_features/3-contextual-score-explanations-070926.md) | Ship `ExplainableScore`, `useScoreExplanation`, static copy first |
| **P0** | `artifacts/stock-compare/src/pages/options-scanner.tsx` | In expanded panel under buildReasoning (L572+): Explain more → shared hook; stopPropagation on control |
| **P1** | `artifacts/stock-compare/src/lib/scanner-reasoning.ts` | Extract `buildReasoning` **only if** home/scanner-simple also import it |
| **P1** | home / scanner-simple (when those tasks exist) | Same pattern |
| — | `artifacts/api-server/src/routes/explain.ts` | **Prefer no change** |

### 4.4 Files to read but not fork

| Path | Why |
|---|---|
| `rankings-leaderboard.tsx` L47–85 | Canonical fundamental POST body |
| `technical.tsx` fetchExplanation | Canonical technical POST body |
| `explain.ts` | Prompt + types — prompts stay server-side |
| new_app_features/3 full PRD | Component API, cache key design, naming (`ExplainableScore` ≠ `ScoreBadge`) |

### 4.5 Cache key + UX algorithm (spec)

```
Always show: buildReasoning(indicator, firstIV, macroRegime)  // deterministic

On "Explain more" click:
  if !canBuildTechnicalPayload(row):
    show CTA to technical scorecard / rankings — no POST
  else:
    key = `fildi_explain_technical_${ticker}_${totalScore}_${signal}`  // include score identity
    // prefer shared hook key scheme from /3 if it already defines one — one scheme only
    if sessionStorage[key]: show cached
    else POST /api/explain/score { ticker, scoreType: "technical", technicalData }
    render AI below deterministic line
    on failure: keep buildReasoning; show soft error (API already soft-fails)

Never: fetch on expand/hover; never N+1 on list poll; never overwrite signal badge from AI
```

Disclaimer copy: “AI narrative — not a trade recommendation.”

### 4.6 Acceptance criteria

- [ ] new_app_features/3 shared component/hook exists (or same PR owns both with /3 checklist done)
- [ ] Network tab: expand scanner row → **zero** explain POSTs
- [ ] Click Explain more with valid payload → one POST; second click → sessionStorage hit (no second POST)
- [ ] AI failure / missing key → buildReasoning still visible
- [ ] Signal badge / buildReasoning text unchanged by AI content
- [ ] No new explain route; no Redis
- [ ] Disclaimer visible near AI text
- [ ] Verifier playbook (ai/9) after UI change: stock-compare typecheck (+ test if touched libs)

### 4.7 Suggested commit message

`feat(ui): wire CSP scanner explain-more via shared score explanation hook`

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **new_app_features/3** | **Hard** — component/hook owner |
| new_app_features/4–5 | Soft — home/simple surfaces |
| ai/1 floors | R3/R4/R8/R9 |
| rankings/technical Why | Become consumers of same hook via /3 — do not leave a third fetch implementation on scanner |

---

## 5. Data sources & API impact
- Existing `POST /api/explain/score` only
- No DB / no migration

## 6. Caching & performance
- sessionStorage only; click-only; list poll must never call explain

## 7. Agent routing
- ui-agent for ExplainableScore consumers; main agent if mapping payloads
- Verify via ai/9 playbook after

---

## Impact & Risk Analysis

- AI must never contradict the GO signal — always stack numbers + buildReasoning above the AI narrative
- Cache key must include score/signal or it serves stale explanations after a score refresh
- Bind ticker strictly with stopPropagation to avoid wrong-ticker clicks in lists
- Gate on `canBuildPayload` — partial technicalData would otherwise cause a 400 or garbage prose
- Don't confuse this with the strike-detail "Why" (Haiku) — different feature
- p95 target <3s, click-only (never universe auto-explain)

**Do not:** auto-explain; second API; LLM overrides scores (R3, R4).  
**Floors:** R3, R4, R8, R9, R10.

---

## Review: APPROVE-WITH-SEQ — ready to build after or merged with new_app_features/3. CSP card Explain more on shared hook, not a new API; prove /3 artifacts exist before a scanner-only PR; map technicalData from technical.tsx pattern.
