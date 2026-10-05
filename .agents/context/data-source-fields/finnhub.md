# Finnhub — free fields

Client: `artifacts/api-server/src/lib/finnhub-client.ts`  
Endpoint: `GET /stock/metric?metric=all` (~112–130 keys depending on ticker).

## Mapped → `finnhub_fundamentals`

PE, PEG, PB, PS, margins, ROE/ROA/ROIC, growth, D/E, current/quick, dividend,
EPS, book value, beta, 52w high/low, FCF margin/share, EV, market cap, …

## Available in metric=all but **not mapped** (probed JPM/O/PGR)

| Key | Use |
|---|---|
| `tangibleBookValuePerShareAnnual` / `Quarterly` | **P/TBV** for banks/insurers/REITs |
| `bookValuePerShareAnnual` | Cross-check BVPS |

## Not present (specialty)

CET1, Tier-1, NIM, NPL, FFO, AFFO, combined ratio, loss ratio — **absent** from free
`metric=all` for JPM / O / PGR (2026-09-29 probe).

## Actionable

Wire `tangibleBookValuePerShareAnnual` → bronze → gold → score metric `ptbv`
(higher TBV yield / lower P/TBV better for financials).
