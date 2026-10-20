# Efficiency playbook — tokens, RPM, drift, compute

> Ops SoT for cost/latency hygiene. Lazy-load + cache are tools; this lists **where money and CPU actually burn**.

Updated: 2026-10-06 (API/LLM optimization pass — shared building blocks below; ASKS A30).

---

## Already in good shape

| Area | Why |
|---|---|
| Explain AI | Every surface goes through `generateExplanation` (`lib/ai-explain.ts`): `explain_cache` + hash, concurrent misses share one Haiku call, cache hits logged + refunded from `aiLimiter` (`markAiCached`). One row per (ticker, surfaceType) — variants that must coexist need their own surfaceType (technical put = `technical`, call = `technical-call`). `/explain/score` body size-capped (`lib/validators/explain.ts`) |
| All Haiku surfaces | Shared `callHaiku` + `aiLimiter` on explain / daily-brief refresh / desk daily-news / macro generate; token cols on `ai_usage_log` |
| Desk normalize | Deterministic pre-Haiku; Daily News Haiku is ad-hoc |
| Fundamentals | Maintain LaunchAgent + budgets; `DISABLE_SCHEDULER_ENRICHMENT=1` on Mac |
| Schwab MD | 100 RPM budget, 30m options + 60s quotes, Yahoo fallback |
| External HTTP | `fetchJsonWithRetry` (`lib/http-client.ts`): per-provider rolling limits, Retry-After, fail-fast 4xx, `nullOn404`, `redactUrl` on every logged/thrown URL |
| Yahoo client | ONE instance — `import { yahooFinance } from "lib/yahoo-client.js"`; never `new YahooFinanceClass()` in server code |
| Local stack | Pidfiles + orphan detection (`scripts/local-stack.mjs`, ApiMonitor chip) |
| Options UI | Overall **and** Watchlist seed from `/options/rankings` snapshots; chains on expand only. Snapshot job = premium candidates **∪ watchlist** (with technicals); watchlist names that fail Overall gates get a **relaxed** second pass (sq/income floors) so Rankings isn’t blank |
| Recent UI | Macro tab-gated; Track Record no path-Yahoo on request; shared `queryKeys.technicalsAll` |

---

## P0 — real waste / risk (remaining)

### 1. AI surfaces **outside** `explainLimiter` — DONE
Shared `aiLimiter` + `callHaiku` token logging on daily-brief `?refresh`, desk daily-news refresh, macro highlights/bank-research.

### 2. Double enrichment / drifting jobs
| Risk | Mitigation |
|---|---|
| API scheduler enrichment **and** `com.fildi.maintain` | Ensure `DISABLE_SCHEDULER_ENRICHMENT=1` always on Mac (document in maintain skill) |
| Stale API/Vite orphans after crash | `./scripts/dev-restart.sh` / ApiMonitor local-stack chip |
| Schwab refresh token expires day 7 | `schwab-health` every 6h (warn only) — still needs human OAuth weekly |
| Cold `/live/state` used to block on hotlist scan | Fixed: background refresh |

### 3. Options / Yahoo residual burn
| Path | Issue | Action |
|---|---|---|
| Watchlist Options batch | Was N chains on load | **Done:** rankings ∩ watchlist; expand-only chains |
| `getOptionPositionQuote` (Portfolio) | Per-position fetch | Batch + short TTL cache |
| Yahoo options fallback | Multi-call per ticker when Schwab miss | Log `source` in ApiMonitor; alert if Yahoo-chain share > X% |
| Term-structure on expand | Extra Yahoo/Schwab | Keep lazy (already); never prefetch |

---

## P1 — excessive processing / payload

| Hotspot | Symptom | Action |
|---|---|---|
| `GET /api/technicals/all` | Large JSON; pulled by Rankings/Live/Options/Home | Shared RQ key exists — add **field projection** (`?cols=`) or split “scoreboard lite” vs full scorer row |
| Overall Options DOM | Was 100–200 `ScannerRow`s | Cap 75 done; next: virtualize if >75 needed |
| Track Record `ticker-summary` | Was path-risk Yahoo | v7: live prices + stored `_pathRisk` only |
| Macro `/charts` cold | ~20 upstream series | Tab-gated client done; next: **split cache** regime-essentials vs liquidity pack on server |
| Live movers | Yahoo screener every visit | **Done:** server `live-movers-combined` 90s TTL + single union `getLivePrices`; client `staleTime` 5m (matches screener) |
| `computeTechnicalRankingsV2` client-side | Re-runs on every side toggle | Memo by `(side, dataRev)`; or precompute nightly into DB |

### Surface ownership (recommendation lenses — do not unify)

| Surface | Owns | Conflict rule |
|---|---|---|
| Live Oversold/Overbought | RSI-side extremes (`rsi<50` / `rsi>50` pools) | Never on both sides |
| Live Top Puts/Calls | Scanner contract score | Soft amber chip vs Model List side |
| Rankings (fund/tech/options) | Universe peer scores | Independent lens |
| Model List | Trade book (SoT when lenses disagree) | Prefer Model; never auto-hide ideas |

`rec-conflicts` (`lib/rec-conflicts.ts` + Live chips) is display-only non-contradiction — not a new ranker.

---

## P2 — AI token hygiene (product + Cursor)

### In-app Anthropic
- Prefer deterministic text (`buildReasoning`) over Haiku when scores unchanged.
- Daily brief: enforce once/day cache (already `fromCache`); never auto-regen on tab focus.
- Desk Daily News: pack size cap already in normalize — keep noise≥70; don’t re-Haiku same session window.
- Tokens already logged: `callHaiku` writes input/output tokens to `ai_usage_log` (misses) and `api.log` (`inputTokens`/`outputTokens`); failures logged too. Next: Settings AI spend strip.
- Admin "Generate" actions (macro highlights, bank research, daily-brief refresh) are wrapped in `singleFlight` (`lib/single-flight.ts`); desk daily-news refresh not yet.
- Bank-research stances feed `regime-classifier` `deriveBankLean` — prompt changes there move the business-cycle regime → before/after + user approval (AGENTS.md rule 5).

### Cursor / agent tokens (this repo)
- Codegraph-first (rule) — avoid Explore subagents for symbol lookup.
- Don’t load `.cursor/tasks/**` or archive plans unless PM task.
- Session wrap + `cursor-state.md` only; never write Claude `state.md`.
- Long prompts: extract Goal/Tasks silently (token-efficiency rule).

---

## P3 — API rate limits (vendor)

| Vendor | Soft cap in product | Watch |
|---|---|---|
| Schwab | 100 RPM token bucket | ApiMonitor RPM chip |
| Yahoo | Cache TTLs + single shared client (one crumb/queue) | Fallback share after Schwab |
| Finnhub | 55/min rolling (`PROVIDER_LIMITS` in http-client) shared by all callers | ApiMonitor |
| Polygon / AV | 5/min rolling + nightly budgets (AV daily = `AV_MAX_DAILY_CALLS`) | Stock DB Pipeline Health |
| SEC EDGAR | 9/s rolling | — |
| FMP | Daily budget only (`checkFMPBudget` / `FMP_MAX_DAILY_CALLS`) | Stock DB Pipeline Health |
| Anthropic | `aiLimiter` 30/15m on all Haiku routes | Done |
| Express general | 300/15m | Fine for single-user Mac |

---

## P4 — refactor / docs (low urgency, high clarity)

| Item | Why |
|---|---|
| Unify fund scorers (client `rankings.ts` vs server fundamentals) | Sector-relative plan leftover |
| Single `queryKeys` for `technicalsAll` / fund / options rankings | Done for Rankings/Live/Options/Tech/TopOptions |
| Drop unused Yahoo chain code paths once Schwab hit-rate >95% for 2 weeks | Less dual maintenance |
| Keep `schwab-market-data.md` + this playbook in INDEX | Done (linked) |
| Stale plan text still mentioning `FUNDAMENTAL_WATCHLIST` as live | INDEX already says removed — archive plan footer only |
| Scheduler `xRunning` flags (9 copy-paste pairs) | Could use one helper; skipped 10/06 — exported to scheduled-tasks/data-health/refetch-queue |
| Sync `readFileSync` in routes | Small JSON; async cascades into sync callers (cache-registry, regime-classifier) — leave |
| `fetchFredCSV` (macro-charts) vs `fetchFredSeriesData` (macro-fred) | Two FRED CSV fetchers — merge when next touched |

---

## Suggested next implementation order

1. ~~Shared AI rate limit + token logging~~ **done**
2. ~~Watchlist option-score snapshots~~ **done**
3. **`technicals/all` lite endpoint** for tables that only need RSI/IV/scores.
4. **Macro charts split** (regime vs liquidity) on server cache files.
5. **Portfolio position-quote batch** + 60s cache.

Do **not** build: multi-model orchestrators, background Haiku loops, Schwab fundamentals replacement for trusted merge.

---

## Quick verify commands

```bash
# Stack drift
node scripts/local-stack.mjs status

# Schwab health (0 MD RPM)
# Settings → Scheduled Tasks → Schwab Auth Health → Run

# AI limiter coverage — every Haiku call goes through callHaiku; each route calling it needs aiLimiter
rg -n "anthropic.messages.create" artifacts/api-server/src   # expect only lib/haiku.ts
rg -n "callHaiku\(|generateExplanation\(|aiLimiter" artifacts/api-server/src/routes

# Drift checks for the shared building blocks
rg -n "new YahooFinance" artifacts/api-server/src/lib artifacts/api-server/src/routes   # expect only yahoo-client.ts
rg -n "^function sleep|async function fetchWithRetry" artifacts/api-server/src          # expect none (use http-client)
rg -n "Cache\.get\(" artifacts/api-server/src/routes                                   # prefer getOrCompute
```


## Explicit development checks — all agents (A197, 2026-10-20)
Use `python3 scripts/oj.py run --local --input <source> --input <test> -- <command> <args>` from the correct package directory (use an absolute oj.py path outside repo root). Repeat `--input` for relevant configuration and dependency manifests. Default timeout 120 seconds; set `--timeout` before `--` for longer checks.

This mode runs the command directly, without shell interpretation or OpenJev. It prints the exit code, first failure matches and tail, and retains the full combined log plus a JSON receipt in a private temporary directory. Receipt records command/cwd, time, exit status and declared-file hashes before/after. No environment values collected. Commands/logs may contain private material: keep them local, never put secrets in arguments, and do not commit raw receipts/logs. Temporary evidence is not durable; record the result and source revision in the ASKS row.

A receipt is evidence of one run, not permission to skip tests. It covers only declared files: recheck dependency/configuration changes, environment, live data and unresolved findings before relying on it. Required ship gates and independent reviews still run. No automatic reuse, retries, dispatch, model startup or hook changes. Existing model-assisted `oj.py run` remains available when appropriate; short deterministic checks use `--local`.

Use the Build / review packet in `research/common/asks/_TEMPLATE.md` for existing and new work: owner/paths, source, acceptance command/cwd, evidence/revision, remaining uncertainty. Link previous evidence instead of copying chat history. One builder; bounded independent review where required. Never replace another agent's session memory.

Measure compact versus full output characters separately from actual model tokens. Report task completion, regressions and interventions alongside tokens; no claimed quota savings from log compression alone.
