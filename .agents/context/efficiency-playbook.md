# Efficiency playbook — tokens, RPM, drift, compute

> Ops SoT for cost/latency hygiene. Lazy-load + cache are tools; this lists **where money and CPU actually burn**.

Updated: 2026-10-04 (P0 AI limiter + watchlist snapshot Options done).

---

## Already in good shape

| Area | Why |
|---|---|
| Explain AI | `explain_cache` + hash; user-click only; `aiLimiter` 30/15m/user |
| All Haiku surfaces | Shared `callHaiku` + `aiLimiter` on explain / daily-brief refresh / desk daily-news / macro generate; token cols on `ai_usage_log` |
| Desk normalize | Deterministic pre-Haiku; Daily News Haiku is ad-hoc |
| Fundamentals | Maintain LaunchAgent + budgets; `DISABLE_SCHEDULER_ENRICHMENT=1` on Mac |
| Schwab MD | 100 RPM budget, 30m options + 60s quotes, Yahoo fallback |
| Local stack | Pidfiles + orphan detection (`scripts/local-stack.mjs`, ApiMonitor chip) |
| Options UI | Overall **and** Watchlist seed from `/options/rankings` snapshots; chains on expand only |
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
| Live movers | Yahoo screener every visit | Raise staleTime; skip when Market tab not focused (page already mostly gated) |
| `computeTechnicalRankingsV2` client-side | Re-runs on every side toggle | Memo by `(side, dataRev)`; or precompute nightly into DB |

---

## P2 — AI token hygiene (product + Cursor)

### In-app Anthropic
- Prefer deterministic text (`buildReasoning`) over Haiku when scores unchanged.
- Daily brief: enforce once/day cache (already `fromCache`); never auto-regen on tab focus.
- Desk Daily News: pack size cap already in normalize — keep noise≥70; don’t re-Haiku same session window.
- Log **input+output tokens** into `ai_usage_log` (today often call-count only) → Settings AI spend strip.

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
| Yahoo | Implicit via cache TTLs | Fallback share after Schwab |
| FMP / AV / Finnhub | Nightly budgets in enrichment | Stock DB Pipeline Health |
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

# AI limiter coverage — grep routes for anthropic.messages.create vs explainLimiter mount
rg -n "anthropic.messages.create|explainLimiter" artifacts/api-server/src
```
