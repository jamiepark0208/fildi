# Verifier follow-ups (2026-07-11)

Action items from gatekeeper re-audit. **Status lives in INDEX/CLUSTERS** — files stay put.

## Code / product

| ID | What | Where |
|---|---|---|
| bug/9 | `findNullFields()` skips peers with no `ticker_fundamentals` row — flagged but unfetched | `nightly-enrichment.ts` |
| bug/5 | `indicatorHistoryCache` + `sepActualsCache` not in sweep/registry (low risk, inconsistent) | `routes/macro.ts` |
| bug/4 | Document `STARTUP_REFRESH_CAP` / `SKIP_STARTUP_REFRESH` | `.claude/skills/build-and-run.md` |
| bug/2 | Auth check on `/indicators/batch?tickers=` | `routes/indicators.ts` |
| bug/13 | React Query bleed: `peer-groups`, `indicators`, `fundamentals-rankings` keys | `home.tsx`, `technical.tsx` → enh/26 |
| bug/17 | Admin cache GET needs `requireAdmin` not just `requireAuth` | `routes/admin-cache.ts` |
| bug/1 | `macro-regime` still public Yahoo on cache miss | `routes/macro-regime.ts` |
| naf/3 | `ExplainableScore.tsx` has zero imports — wire or delete | `stock-compare/src/components/` |
| enh/4 | Route supertest for 401-without-cookie (bug/1 AC) | api-server test harness |

## Verified closed (no re-do)

bug/1–5, 9–13 · bug/19 rejected · enh/3,4,7 · naf/3 — pass or pass (conditional). bug/11–12: batch `/options` + `/stocks/quotes`. bug/5: prune + maxEntries + sweep (macro.ts orphans noted above).

## Next build

Cluster C: bugs **6, 8, 18** · then 14–17 · enh/34 Wave A
