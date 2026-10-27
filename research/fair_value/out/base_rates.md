# Base rates for DCF v2 (Compustat US, fiscal years 1990–2020 start, revenue ≥ $0.5B nominal) — 2026-10-27

Built by `research/fair_value/base_rates.py` (aggregated on WRDS; nothing per firm stored). Raw tables: `base_rates_*.pkl`.
Forward CAGRs exclude firms that left Compustat (exit columns show how many). Nominal dollars.

## Revenue growth persistence (P10/P25/P50/P75/P90, %/yr)
See `base_rates_growth.pkl`. Highlights: median growth fades to 3–11 %/yr within 5 years in every bucket; the chance of
> 15 %/yr for 10 years is 1–6 % for 0–20 % growers and 11–33 % for > 30 % growers; larger companies fade faster
(> $50B with > 30 % growth: median 2–3 %/yr over the next 5 years). Exits within 5 years: 2–34 %, almost all
acquisitions; bankruptcy/liquidation 0–2 %.

## Operating margin 5 years later, by sector × starting margin
Sticky: the median stays in or next to its starting bucket (tech 20–30 % → 22 %, > 30 % → 30 %; staples > 30 % → 41 %).

## ROIC 5 years later and sales-to-capital
ROIC fades partly toward ~10–15 % (tech > 40 % → 28 %, 15–25 % → 15 %; staples > 40 % → 48 %). Sales-to-capital
median: tech 1.1, health 1.1, industrials 1.1, discretionary 1.5, staples 1.9, materials 0.9, energy 0.6, comm 0.6,
financials 0.3, utilities 0.2, real estate 0.2.
