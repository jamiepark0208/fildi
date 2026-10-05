# FMP (Financial Modeling Prep) — free fields

Client: `artifacts/api-server/src/lib/fmp-client.ts`  
Endpoints used: key-metrics, ratios, income-statement, balance-sheet, cash-flow (ann+qtr),
financial-growth, wacc, price-target-consensus (~9 calls/ticker).

## Currently mapped → bronze `fmp_fundamentals`

| Interface field | API origin |
|---|---|
| peRatio, pegRatio, forwardPe, evEbitda, evRevenue, priceToBook, priceToSales | ratios / key-metrics |
| dividendYield, debtToEquity, currentRatio | ratios |
| revenueGrowthYoY/Prior, epsGrowth | financial-growth |
| margins, ROE, ROA, effectiveTaxRate | ratios |
| totalRevenue, netIncome, ebitda, ebit, interestExpense, shares* | income-statement |
| totalDebt, equity, cash, **totalAssets**, grossProfit | balance / income |
| FCF, annualOCF, quarterlyOCF | cash-flow |
| wacc, roic, analystTargetPrice | wacc / key-metrics / consensus |

## Free `ratios` extras we do **not** map yet (probed JPM 2026-09-29)

`tangibleBookValuePerShare`, `bookValuePerShare`, `cashRatio`, `quickRatio`,
`debtToAssetsRatio`, `financialLeverageRatio`, `interestCoverageRatio` (we derive),
`priceToFreeCashFlowRatio`, `operatingCashFlowPerShare`, …

## Free `key-metrics` extras unused

`tangibleAssetValue`, `returnOnTangibleAssets`, `netDebtToEBITDA` (we derive),
`incomeQuality`, `stockBasedCompensationToRevenue`, `grahamNumber`, `enterpriseValue`, …

## Specialty — probed

| Endpoint / field | Result |
|---|---|
| `/bank-ratios` | **404** on free |
| CET1, Tier1, NIM, NPL, combined ratio, FFO | **Absent** from free ratios/key-metrics |
| Soft cap | HTTP **402** common after daily use |

## Actionable free fills

1. Map **`tangibleBookValuePerShare`** → gold `tangibleBookValuePerShare` → metric **P/TBV** for financials.
2. Prefer FMP `totalAssets` when endpoint not 402; else keep derive path.
3. Do not pretend CET1/FFO exist on free FMP.
