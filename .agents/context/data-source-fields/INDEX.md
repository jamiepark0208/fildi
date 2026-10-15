# Data source fields — index

Inventories of **free-tier** fields we can actually pull today, vs specialty gaps
(CET1, FFO, combined ratio, …). Keep these updated when a client interface changes.

**Endpoint-level entitlements (every source probed live 2026-10-14): [endpoint-entitlements.md](./endpoint-entitlements.md). Read it before planning a data feature.**

| Source | File | Plan / cost |
|---|---|---|
| FMP | [fmp.md](./fmp.md) | Free ~250 calls/day; per-symbol endpoints mega-cap only (2026-10-14) |
| Yahoo | [yahoo.md](./yahoo.md) | Free via yahoo-finance2 |
| Finnhub | [finnhub.md](./finnhub.md) | Free metric=all |
| EDGAR | [edgar.md](./edgar.md) | Free SEC companyfacts / XBRL |
| Polygon | [polygon.md](./polygon.md) | Free Basic 5/min end-of-day; financials endpoint GONE (2026-10-14) |
| Alpha Vantage | [alpha-vantage.md](./alpha-vantage.md) | Free 25/day; earnings-call transcripts (transcripts.py) |
| FactSet | [factset.md](./factset.md) | Paid referee — not free; listed for gap awareness |

## Specialty metrics — can we fill them?

| Metric | Needed for | Free source? | Path |
|---|---|---|---|
| **CET1 / Tier-1** | Banks | **No** on FMP free ratios, Finnhub metric=all, Yahoo, EDGAR common tags | Paid FMP/FactSet bank package — or skip and use **P/TBV + ROE** (available) |
| **FFO / AFFO** | REITs | **No** named FFO on free FMP/Finnhub | **Derive** FFO ≈ NI + D&A from EDGAR `DepreciationAndAmortization` (tag exists) |
| **Combined ratio** | Insurance | **No** on free APIs probed | Paid — use ROE + P/TBV + FCF until then |
| **NIM / NPL / efficiency** | Banks | **No** on free FMP (`bank-ratios` 404) | Same as CET1 |
| **Tangible book / P/TBV** | Banks, insurers | **Yes** — FMP `tangibleBookValuePerShare`; Finnhub `tangibleBookValuePerShareAnnual` | Wire into gold + score (not yet in gold) |
| **totalAssets** | GPA, accruals, F-Score | FMP BS (often 402); **derive** NI/ROA or Debt+Equity | `backfill-total-assets.ts` |

## Scoring implication

Do **not** wait for CET1/FFO/combined to claim expert-ready. Use available proxies
(P/TBV, derived FFO, peer×sector blend) and document residual gaps honestly.
