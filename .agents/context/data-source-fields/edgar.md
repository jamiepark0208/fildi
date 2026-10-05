# SEC EDGAR — free fields

Client: `artifacts/api-server/src/lib/edgar-client.ts`  
Sources: companyfacts us-gaap XBRL (10-K FY).

## Mapped (fundamentals + statement history)

Revenue, gross profit, net income, EBIT/EBITDA, equity, debt, cash, OCF, FCF,
shares, margins (computed), **totalAssets** (history line item; not always on wide row).

## Usable for specialty derives (tags exist in companyfacts)

| Tag | Derive |
|---|---|
| `DepreciationAndAmortization` / `Depreciation` / `RealEstateAccumulatedDepreciationDepreciationExpense` | **FFO proxy** ≈ NI + D&A (REITs; NAREIT simple form) |
| `Assets` | totalAssets (already in STATEMENT_LINE_ITEM_TAGS) |

## Not available as standard us-gaap for CET1 / combined ratio

Bank regulatory capital and insurance combined ratio are **not** reliable free us-gaap
tags across the universe. Do not invent from EDGAR.

## Actionable

1. Add D&A to `STATEMENT_LINE_ITEM_TAGS` + bronze/gold.
2. Gold `ffoProxy = netIncome + depreciationAmortization` for `scoring_mode=reit`.
3. Score REIT value with **P/FFO** instead of P/E when ffoProxy present.
