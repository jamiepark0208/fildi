# Fair value sources — inventory (A283, 2026-10-29, Claude)

Jamie 10-29: find more sources before the fair value v2 design, including ones labelled "intrinsic value".
Fair value is display only: it never gates or sizes a rec.

## Inventory
| Source | Family | Cost | Access | Coverage | Status |
|---|---|---|---|---|---|
| LSEG StarMine Intrinsic Value | cash-flow (analyst-estimate DCF) | have | API (signals_daily.price_to_intrinsic) | ~186 / 271 names | stored daily → `watchlist_sync.external_intrinsic` source starmine |
| FMP DCF + levered DCF | cash-flow (mechanical) | have | API `/stable/discounted-cash-flow`, `levered-discounted-cash-flow` | large caps only; NET/SNOW/MRVL "Premium" | stored weekly (external_iv.py, --max 40/day) |
| Fildi lab DCF (dcf/engine.py) | cash-flow (probabilistic) | $0 | own | watchlist + engine names | P10/P50/P90; it2 values are not persisted to `dcf_valuations` (last row 10-27) |
| Fildi Rankings fv-1.2.0 | multiples/blend | $0 | own | universe | live display |
| Street PT median (LSEG pt_mean, IBES, FMP) | street | have | API | ~270 names | stored |
| Trading Central via Yahoo `insights` | multiples/relative | free | unofficial Yahoo API (Node yahoo-finance2, `validateResult:false`) | most US names | **new, not stored.** Gives label + discount % only (PLTR "Overvalued 17 %", MSFT "Near fair value 14 %", NVDA "Undervalued 51 %"), no $ value; how the % maps to a $ is not documented |
| GuruFocus GF Value + DCF | multiples history (GF Value) + cash-flow (DCF) | **free 100 queries/mo**; $200/mo Builder | official Data API, needs a GuruFocus account + key | US + global | **new, best add.** 100/mo covers the watchlist monthly. Needs Jamie to create the account (accounts = his call) |
| Morningstar Fair Value Estimate | street-like (analyst DCF) | enterprise (Agent API, price on request) | official API, sales contact | ~1,500 covered names | not reachable: Yahoo lists the Morningstar reports but the $ value is premium; Schwab API has none. Manual entry for hand-test names only |
| Alpha Spread intrinsic value | cash-flow + multiples (base case) | paid ~$144/yr+, API tier mentioned (~$150/mo, unconfirmed) | site; API docs not public | global | pricing page did not load (JS); low priority |
| Simply Wall St fair value | cash-flow (2-stage DCF) | paid | no official API (scrape only) | global | skip (no API, ToS) |
| valueinvesting.io | cash-flow + multiples | paid | no API found | global | skip |
| Finbox fair value (model average) | blend | paid | API conflicting (one review yes, 2026 comparison no) | US | skip until confirmed |
| Zacks | street/quant | WRDS `zacksamp` sample only | research-only | sample | skip |
| Argus (via Yahoo reports) | street | premium | report text only | — | skip |

## Same 7 names, today (10-29)
| Ticker | Price | StarMine IV | FMP DCF / levered | Lab DCF P50 (10-27) | Street PT | Trading Central |
|---|---|---|---|---|---|---|
| PLTR | 197 | 38 | 9 / 16 | 24 (it2: 40) | 210 | overvalued 17 % |
| MSFT | 531 | 377 | 281 / 312 | 260 | 615 | near fair 14 % |
| NVDA | 215 | 250 | 228 / 238 | 113 | 325 | undervalued 51 % |
| GOOGL | 325 | 264 | 98 / 128 | 122 | 413 | — |
| MRVL | 252 | 121 | premium | 15 | 339 | — |
| NET | 319 | 28 | premium | 5 | 344 | — |
| SNOW | 340 | 48 | premium | −6 | 427 | — |

Read: the street sits above price on all 7 names. On high-growth software (PLTR, NET, SNOW, MRVL), every cash-flow source sits at 5–50 % of price.
Cash-flow sources still disagree with each other (StarMine NVDA 250 vs lab 113; GOOGL 264 vs FMP 98), so the cash-flow chip has to be a range, not one value.
A single median would land on whichever family has more sources.
This supports the 3-chip design (street · cash-flow band · reverse DCF) with no headline number when the families differ by more than 2×.

## Next
1. Jamie: create a GuruFocus account and add the free Data API key → GF Value + GF DCF join the cash-flow chip (100 queries/mo).
2. Store Trading Central label + % (Node job, vendor_raw, 7-day refresh) as a fourth context line (no $).
3. Persist lab DCF it2 runs to `dcf_valuations` so the chip reads today's engine, not 10-27.
