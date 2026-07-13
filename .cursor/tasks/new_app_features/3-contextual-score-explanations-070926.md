# contextual-score-explanations

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P0 |
| **Area** | ui (+ thin frontend hook; no API changes v1) |
| **Effort** | M (~1–2 build sessions) |
| **Created** | 2026-07-09 |
| **Source** | competitive-ux-research |
| **Related** | [2-onboarding](2-onboarding-product-tour-070926.md), [ai/11 product-ai-explain-csp](../ai/11-product-ai-explain-csp-070926.md), [enh/20 scorecard-guide](../enhancements/20-scorecard-guide-improvements-070926.md) |

### Resolution (2026-07-10)
Shipped `ExplainableScore` component + `useScoreExplanation` shared hook + `score-summary-copy.ts` static one-liners, replacing two duplicate "Why" fetch implementations in `rankings-leaderboard.tsx` and `technical.tsx`. Popover shows static copy immediately; "Explain more" (fundamental/technical only) calls `POST /api/explain/score`, cached in-session client-side and now also checked server-side against a new `explain_cache` DB table (keyed on ticker + score_type + score_hash) before calling Haiku, so repeat requests across users are free. Wired onto rankings/technical leaderboards, stock cards, scanner signal badges, and TradeCard. Guide page now reads `?tab=` for deep-linking from popovers; sidebar label renamed "Scorecard Guide" → "Scoring Reference." Architecture decision: score explanations persist to DB (objective, shared across users) while macro/portfolio briefs stay in per-user JSON files. All tests passing (35/35 api-server, 268/268 stock-compare), both typechecks clean.
