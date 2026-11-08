# WS3: AV in FIELD_DEFS — Findings

**Date:** 2026-07-09  
**Status:** Already complete — no code changes needed

## Finding

Alpha Vantage is already wired into `FIELD_DEFS` in `merge-trusted.ts` as the lowest-priority tier for all 12 of its fields:

| AV Field | FIELD_DEFS priority position |
|---|---|
| peRatio | Last (after yahoo, finnhub, fmp) |
| forwardPe | Last (after yahoo, fmp) |
| pegRatio | Last (after yahoo, fmp) |
| priceToBook | Last (after yahoo, finnhub, fmp) |
| operatingMargin | Last (after yahoo, finnhub, fmp, polygon) |
| netMargin | Last (after yahoo, finnhub, fmp) |
| returnOnEquity | Last (after yahoo, finnhub, fmp) |
| totalRevenue | Last (after yahoo, fmp, edgar, polygon) |
| ebitda | Last (after yahoo, fmp, edgar) |
| beta | Last (after yahoo, finnhub, fmp) |
| dividendYield | Last (after yahoo, finnhub, fmp) |
| analystTargetPrice | Last (after yahoo, fmp) |

## Why AV Contribution Is Low (alpha_vantage=1 in current run)

AV backfill has only completed for **14 tickers** (A through ADYEN) at 25 calls/day. For those 14 tickers, Yahoo and Finnhub already provide most of the overlapping fields, leaving only 1 case where AV was the best available source.

## Action Required

No code changes. Continue AV backfill (resumes from ADYEN, 25/day). After each daily batch:
1. Run `backfill-av.ts` (25 calls)
2. Run `populate-source-fundamentals.ts` (or equivalent silver-layer refresh)
3. Run `merge-trusted.ts`

Expected improvement: `dividendYield`, `peRatio`, `pegRatio`, `ebitda`, `beta` gaps will fill as AV backfill progresses through the 257-ticker universe (~10 more days at 25/day).
