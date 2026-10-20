# S049-crash — Do panic puts fail in broad or sector-wide crashes?
2026-10-20 · Claude · **Plan claim wrong; cap kept as a tail rule** · `scripts/watchlist_sync/analysis/s049_crash_reaudit.py` · report `scripts/watchlist_sync/out/opt/S049_crash.md`

## Question
PLAN-buy-zone-puts §1.1 claimed "market- or sector-wide crashes are the losing case" for panic puts (S049/S054), citing the Feb 2026 loss. True?

## Data
S049 simulated trades for 2022, 2025 and 2026: 1,159 panic events and 1,279 random-day baselines. Monthly 0.20Δ puts at real LSEG mids, held to expiry.

## Method
- Broad crash = SPY 20-day return < −5 % at entry.
- Sector cluster = ≥ 3 other same-sector panic events within ±5 days (sector = `ticker_registry.primary_peer_group_id` prefix).
- Compared with baselines in the same regime; bootstrap by expiry week.

## Result
| slice | n | mean % collateral | ITM | worst 10 % |
|---|---|---|---|---|
| panic, idiosyncratic | 778 | +1.25 % | 22 % | −10.5 % |
| panic, broad crash | 381 | **+2.45 %** | 14 % | −8.4 % |
| panic + IV > 48.7, idiosyncratic | 413 | +2.18 % | 21 % | −12.2 % |
| panic + IV > 48.7, broad crash | 246 | **+3.45 %** | 13 % | −7.5 % |
| panic + IV > 48.7, alone in sector | 219 | +2.72 % | 20 % | −9.5 % |
| panic + IV > 48.7, sector cluster | 440 | +2.62 % | 18 % | −11.5 % |
Sector cluster worst decile by year: 2022 −15.3 % vs −13.7 % alone; 2025 −5.3 % vs −7.7 %; **2026 −11.5 % vs −3.5 %**.

## Verdict
Broad market crashes were the **best** case for panic puts, not the worst. The live rule (panic + IV > 48.7) beats same-regime baselines in both (broad p 0.005, idiosyncratic p < 0.001); plain panic puts in broad crashes do not beat broad-crash baselines (p 0.23 — all puts did well then).
Only 7 of 2026's panic trades were in a broad crash, so the Feb 2026 loss was a sector crash (software). Sector clusters keep the same average
but fatten the tail in 2 of 3 years.

## Decision
Keep "≤ 2 per peer group" as a **tail/sizing** rule (S016 ρ 0.6). Drop the "broad crash = losing case" flag from the plan.

## Known weaknesses
2026 broad-crash n = 7. 2022 dominates the broad-crash arm (284 of 381), so this is mostly one bear market. Sector = first level of the peer id only.
