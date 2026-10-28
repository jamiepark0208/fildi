# Runtime framework audit — vendor budgets, retries, caching (Claude, 2026-10-28)

Jamie: "a lot of our performance issues are API budgets being exceeded and loops trying to reconnect … double check our framework."

## Verdict
The building blocks are mostly sound: one TTL cache with in-flight coalescing, a shared HTTP helper (per-call timeouts, jittered back-off, Retry-After, 4xx = no retry), per-vendor rate limits, DB-first stores, maintenance jobs. Those help and stay.

The flaw is in **failure paths and process boundaries**. Each outage was patched where it hit (Polygon gate, Yahoo circuit, yield-curve salvage), so protection exists for whatever broke last and nowhere else. Three gaps recur:
1. **Failure = retry immediately.** Caches stored nothing on failure, so every caller retried the dead vendor at once (retry storm). They also returned an error even when a good value from minutes earlier existed.
2. **No circuit or timeout on some vendors.** Schwab requests had no timeout and no circuit, so during an outage every queued call waited its rate-limit slot, then failed slowly. Schwab token refresh restarted as soon as it failed (20 attempts in one minute, twice).
3. **Budgets enforced per process.** The API server, Python pipeline and scripts each believe they own a vendor's whole budget. Polygon has a cross-process gate; Finnhub, FMP and SEC don't.

Amplifier: the API restarted ~10×/h on agents' edits (watch mode), wiping every cache and re-running every refresh (FRED: 63 failures in a minute, 3 restarts in 3 min).

## Evidence (api.log + api_usage, 10-25 → 10-28)
| Signal | Count | Cause |
|---|---|---|
| schwab: fetch threw | 260 | no timeout/circuit on network failure |
| fred failures | 171 (250 calls on 10-27 vs 2 normal) | outage × restarts × ~60 series per refresh |
| schwab-auth refresh threw | 48 (20/min bursts) | no cooldown after failed refresh |
| API restarts | 196 in ~19 h | `node --watch` + agents' edits |
| /schwab/chain-ladder | 99 calls/min | skew-survey batch at the 100-rpm limit, FIFO ahead of clicks |
| /live/state | one 55 min hang | Asia chart() without deadline inside a shared cache promise |

## Fixed today (all committed, tested)
- API dev:once + restart on sync only (`dev-restart.sh --api`); Vite HMR off.
- **TTLCache (every cache):** last good value kept 6× TTL (≤ 24 h) and served when compute fails; 15 s fail-fast cooldown. Tests 11/11, API suite 445/445.
- **Schwab:** 15 s request timeout, network circuit (3 fails/60 s → skip 60 s), batch lane (app requests first), token refresh 10 s timeout + 60 s cooldown.
- **Prices:** stale-while-revalidate + last-good saved to disk (first load after restart 365 ms → 1 ms).
- **Options chains:** DB snapshot first, market-hours warmer (119 names, 1 call at a time), page re-asks for fresh quotes.
- COT and short-interest SWR; Asia chart deadline (in Cursor's WIP → A302).
- **Detection:** `scripts/perf-watch.mjs` every 30 min (LaunchAgent) → agent_start 5c. **Prevention:** `scripts/perf-guards.sh` on every push; AGENTS.md 8c.

## Still to do (A303)
1. **One vendor policy table** (`http-client.ts`): per vendor {timeout, retries, rate limit, circuit, cross-process?}. Yahoo, Schwab, FRED and CNN each hand-roll theirs today; FRED/CNN have no circuit.
2. **Cross-process budgets** for Finnhub (60/min), FMP, SEC (10/s): generalize the Polygon flock gate (`polygon-limiter.ts` + `polygon_gate.py`) into one `vendor_gate` used by Node and Python.
3. **Macro merge-with-prior for every field** (today only the yield curve and 20 chart series): an empty fresh series never overwrites a good saved one. `routes/macro.ts` holds uncommitted WIP; do it after that lands.
