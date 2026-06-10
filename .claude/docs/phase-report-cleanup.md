# Phase Report: CLAUDE.md Cleanup + AI Score Explanations

## Status
- Phase 0: RECON COMPLETE
- Phase 1: COMPLETE
- Phase 2: COMPLETE
- Phase 3: COMPLETE

---

## Phase 0 — Recon Findings

### 0a. CLAUDE.md Audit

**Skills files present in `.claude/skills/`** (11 files):
```
build-and-run.md       data-architecture.md   db-patterns.md
feature-planner.md     options-pricer.md       replit-setup.md
session-wrap.md        signal-filters.md       startup.md  ← NOT in SKILLS INDEX
technical-scorecard.md trader-context.md
```

**`ui-components.md` — CONFIRMED MISSING.** Referenced in SKILLS INDEX but does not exist.
Decision: create a minimal stub (~50 lines) covering React/Tailwind patterns used in this project.

**Stale APP SUMMARY statements:**
- Describes v1 UI only; omits entire scoring architecture (V2 fundamental, V2 technical, FMP, Macro, Portfolio, Daily Brief)
- "Phase 2: social 1%/week challenge" — never built; remove
- Missing: FMP data source, two independent scorer layers, DB tables, data sources

**SESSION LOG size:** 141 lines (lines 72–213). Sessions from 2026-06-02 and 2026-06-03 qualify for archival (4 sessions pre-2026-06-08).

**FILDI_ROADMAP.md:** Does not exist. ROADMAP section in CLAUDE.md should reference it as a convention/pointer rather than a live file.

---

### 0b. AI Explanation Pattern Audit

**Anthropic API pattern (`artifacts/api-server/src/routes/daily-brief.ts`):**
```typescript
import Anthropic from "@anthropic-ai/sdk";
const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });

const msg = await anthropic.messages.create({
  model:      "claude-haiku-4-5-20251001",
  max_tokens: 1200,
  messages:   [{ role: "user", content: prompt }],
});
return msg.content[0].type === "text" ? msg.content[0].text : "";
```
- Env var: `process.env["ANTHROPIC_API_KEY"]`
- No streaming. Route handler wraps in try/catch.

**`scorecard-explanation.tsx`:** Static metric definition reference page — weight tables for
SCORECARD_METRICS_V2 and TECHNICAL_SCORECARD_METRICS. No AI, no per-ticker content.

**Fundamental reason location:**
`artifacts/stock-compare/src/components/rankings-leaderboard.tsx` lines 51–54
"Explain" button goes directly below this block.

**Technical reason location:**
`artifacts/stock-compare/src/pages/technical.tsx` — `TechnicalLeaderboard` function, lines 344–347
"Explain" button goes directly below this block.

**Existing expand/detail panels:** None in either leaderboard. No accordion exists today.

---

### 0c. Score Data Available at Render

**Fundamental `StockScore` — all fields available at `RankingsLeaderboard` render:**
- ticker, companyName, totalScore, rank, reason ✓
- metricScores: Record with value/weightedScore/rank for all 13 V2 metrics ✓
- familyScores?: { value, growth, quality, safety } each { score, coverage, lowCoverage } ✓
- dataQuality?: "good" | "partial" | "insufficient" ✓
- gateStatus?: "ok" | "flagged" ✓
- suspectMetrics?: string[] ✓

Everything needed for the fundamental prompt is directly in StockScore.

**Technical `TechnicalScore` — fields at `TechnicalLeaderboard` render:**
- ticker, totalScore, rank, signal, tier, reason ✓
- componentScores?: Record<string, {score, weight}> ✓
- regime?: "BULLISH" | "NEUTRAL" | "BEARISH" ✓
- gateStatus? ✓
- rsi14, rsi14Pct, ivRank, macdDirection, fallingKnife, earningsDaysOut — **GAP: TechnicalRow only**

**Gap resolution (Phase 3):** Add `rowMap?: Record<string, TechnicalRow>` prop to `TechnicalLeaderboard`.
Pass from parent's existing `allTechnicalsData` array.

---

### Routes Registration
`artifacts/api-server/src/routes/index.ts` — `router.use(...)` pattern.
New explain router = one additional line. No /api prefix in route files.

---

## Key File Locations (phases 2–3)
| Purpose | File |
|---|---|
| Anthropic API pattern reference | `artifacts/api-server/src/routes/daily-brief.ts` lines 3, 9, 209–215 |
| New explain route (to create) | `artifacts/api-server/src/routes/explain.ts` |
| Routes registration | `artifacts/api-server/src/routes/index.ts` |
| Fundamental leaderboard | `artifacts/stock-compare/src/components/rankings-leaderboard.tsx` |
| Technical leaderboard | `artifacts/stock-compare/src/pages/technical.tsx` lines 296–374 |
| TechnicalScore type | `artifacts/stock-compare/src/lib/technical-rankings.ts` line 66 |
| StockScore type | `artifacts/stock-compare/src/lib/rankings.ts` line 33 |
