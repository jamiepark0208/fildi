# Polygon — free fields

Client: `artifacts/api-server/src/lib/polygon-client.ts`  
Endpoint: `/vX/reference/financials` annual.

## Mapped

totalRevenue, netIncome, gross/operating margin (computed), interestExpense,
totalDebt (via liabilities — coarse), equity, quarterly OCF.

## Gaps

No CET1/FFO/combined; sparse coverage vs Yahoo/FMP. Use as fallback only.
