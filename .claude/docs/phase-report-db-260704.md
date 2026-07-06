# DB Phase Report — 2026-07-04/05

## Current state (as of 2026-07-05 ~20:00 UTC)

### Table row counts

| Table | Rows | Notes |
|---|---|---|
| fmp_fundamentals | 257 | Canonical universe. 168 original + 89 added 2026-07-05 (88-ticker peer-group expansion + IONQ separate INSERT). Phase report previously said 256 — miscounted. |
| yahoo_fundamentals | 281 | 161 original + 120 canonical backfill |
| finnhub_fundamentals | 158 | |
| edgar_fundamentals | 158 | |
| polygon_fundamentals | 0 | Empty — awaiting backfill |
| av_fundamentals | 0 | Empty — awaiting backfill |
| source_fundamentals | ~15,809 | Silver layer. All sources, canonical field names. |
| ticker_fundamentals | 257 | Gold layer. Merged via merge-trusted.ts. |
| field_provenance | 6,726 | Populated by last merge run 2026-07-05 17:52 UTC |
| manual_overrides | 0 | |

### Stale/renamed tickers (handled 2026-07-05)
- JNPR deleted (acquired by HPE, delisted)
- DISH → ECHO, PSTG → P, SQ → XYZ (in-place rename across all 9 tables)
- source_ticker_map updated: ticker=new symbol, source_ticker=old symbol, notes=rename date

### Yahoo canonical coverage
164 / 257 tickers have usable Yahoo data in source_fundamentals.
Zero-data tickers: HBI (fetched, all-null). ECHO/P/XYZ re-fetched after rename — all now have data.

---

## Data layer architecture

**Pipeline: Bronze → Silver → Gold**
1. Bronze staging (fmp/yahoo/finnhub/edgar/polygon/av_fundamentals) — one row/ticker, source-prefixed cols
2. `populate-source-fundamentals.ts` → silver (`source_fundamentals`, PK: ticker+source+field)
3. `merge-trusted.ts` → gold (`ticker_fundamentals` + `field_provenance`)

**merge-trusted.ts FIELD_DEFS priority (hardcoded, single source of truth):**
- Valuation: yahoo → finnhub → fmp
- Margins/returns: yahoo → finnhub → fmp (never edgar — period mismatch)
- debtToEquity: yahoo → fmp (never finnhub — definitional mismatch)
- Balance sheet: yahoo → finnhub → edgar → fmp
- Income statement: yahoo → fmp → edgar
- Cash flow: yahoo → fmp → edgar
- wacc, roic, priceToSales, effectiveTaxRate, revenueGrowthYoyPrior, sharesOutstandingPrior: fmp only
- **Polygon and AV: NOT in FIELD_DEFS — cross-validation only, no path to ticker_fundamentals**

---

## Backfill scripts (api-server/src/scripts/)

| Script | Skip logic | Rate limit | Dry-run result |
|---|---|---|---|
| backfill-fmp.ts | Staleness: fmp_wacc/fmp_roic non-null AND fetchedAt < 7d | 9 calls/ticker; checkFMPBudget/recordFMPCalls | 247 fetch / 10 skip / 2223 calls |
| backfill-polygon.ts | Yahoo+Edgar cover 6 checkable fields in source_fundamentals | 3 concurrent, 1s between batches | 175 fetch / 82 skip |
| backfill-av.ts | Staleness: av_fundamentals.fetchedAt < 7d | 25/day; cursor in logs/av-cursor.json | 257 fetch / 0 skip (empty table) |

All support `--dry-run`. Build: `node build-script.mjs src/scripts/<name>.ts`

**Polygon skip-check uses only 6 of 8 fields:** totalRevenue, netIncome, grossMargin, operatingMargin, interestExpense, totalDebt. Excluded: `totalStockholdersEquity` (Yahoo→"annualTotalEquity", Edgar→"totalEquity") and `quarterlyOperatingCashFlow` (Yahoo/Edgar→"operatingCashFlow") — different canonical names, never satisfiable.

**AV field-coverage skip removed:** peRatio + dividendYield never appear in Yahoo source_fundamentals, so "all covered by Yahoo" could never fire.

---

## Critical field-name mapping facts

Yahoo writes to source_fundamentals under names that differ from ticker_fundamentals cols:
- `totalStockholdersEquity` → Yahoo: `annualTotalEquity`; Edgar: `totalEquity`
- `quarterlyOperatingCashFlow` → Yahoo/Edgar: `operatingCashFlow`
- `revenueGrowthYoY` → Yahoo: `revenueGrowth`
- `cashAndEquivalents` → Yahoo: `totalCash`
- `earningsPerShare` → Yahoo: `trailingEps`
- `peRatio` → not in Yahoo source_fundamentals
- `dividendYield` → not in Yahoo source_fundamentals

merge-trusted FIELD_DEFS handles this via per-field source+fieldname pairs, e.g.:
`{ tfCol: "totalStockholdersEquity", priority: [["edgar","totalEquity"], ["fmp","totalStockholdersEquity"]] }`

---

## Stock DB tooltip + override system (complete)

- `field_provenance` (PK: ticker+field): winning_source, winning_value, is_override, divergent
- `manual_overrides` (PK: ticker+field): override_source, override_value, note
- API: GET/PUT/DELETE `/fundamentals/provenance/:ticker` + `/fundamentals/override`
- StockDBTab: per-cell Radix Popover, source breakdown table, override form
- Server: provenanceCache (TTLCache 15min), invalidated on override save and merge batch
- Client: AbortController via react-query signal, 10min staleTime, refetchOnWindowFocus
- **field_provenance needs re-run of merge-trusted after universe expansion (current rows pre-expansion)**

---

## Pending null coverage (canonical 257, post-Yahoo backfill)

FMP backfill targets: wacc(257/257), priceToSales(~245/257), roic(~245/257), revenueGrowthYoyPrior(~245/257), sharesOutstandingPrior(~245/257), effectiveTaxRate(~245/257), epsGrowth(~230/257), dividendYield(~225/257), interestExpense(~215/257)

---

## Run order for live backfills (after midnight UTC)

1. `backfill-fmp.mjs` — repeat daily (~10 days, 247 tickers × 9 calls / 250 budget)
2. `backfill-polygon.mjs` — one shot (175 tickers)
3. `populate-source-fundamentals.mjs`
4. `merge-trusted.mjs` — refreshes field_provenance
5. `backfill-av.mjs` — 25/day, resumable (~11 days)

---

## Step results (2026-07-06 session)

### Step 1 — Universe audit (COMPLETE, awaiting confirmation)

**Result:** 257 unique tickers in `fmp_fundamentals`, no duplicates. All 257 are in `ticker_registry`. Batches:

| Date | Count | Batch |
|---|---|---|
| 2026-06-14 to 06-26 | 158 | Original seed (MSFT first, then bulk backfill) |
| 2026-06-30 to 07-04 | 10 | Incremental: NVDA, PLTR, HOOD, INTC, GOOGL, TSLA, BABA, AMZN, AAPL, NFLX |
| 2026-07-05 | 89 | Peer-group expansion: semis (ON, ADI, NXPI, QCOM, MU, MRVL, ARM), cyber (CYBR, CRWD, ZS, TENB, RPD, QLYS, S), fintech (COIN, SOFI, PYPL, FISV, GPN, FOUR, NU, ADYEN, PAGS, FIS, BILL), payments (WDAY, INTU, CRM, ORCL, SAP, NOW), space (RKLB, LUNR, RDW, SPCE, SPCX), consumer internet (UBER, LYFT, DASH, SNAP, RDDT, ROKU, TTD, DUOL, ETSY, OPEN, WBD, MTCH, BMBL, GRAB, SE, MELI), SaaS (DDOG, SNOW, MDB, DOCU, TEAM, MNDY), storage/infra (NTAP, ANET, SMCI, HPQ, HPE, DELL), misc (SPOT, PINS, SOFI, TOST, COMP, RKT, SG, IONQ, BB, DDD, SOUN, POET, QSI, TEM, BULL, ONDS, LDI, PN, LQDA, SUPX, GFS, WOLF, REBN, FSLY, RUM) |

**Verdict: Bug, not intentional expansion.**

Root cause chain:
1. Peer-group expansion session added 89 tickers to `ticker_registry` + `peer_group_members` (correct — for scoring comparisons)
2. `backfill-fundamentals.ts` (legacy) reads WATCHLIST + all `peer_group_members` → writes to `ticker_fundamentals` via `writeFundamentalsRow()`
3. `snapshot-to-staging.ts` ran (labeled "one-time migration script") — reads ALL `ticker_fundamentals`, upserts into `fmp_fundamentals` with no filter → promoted all 89 peer-group tickers into the canonical universe table
4. `merge-trusted.ts` line 214 uses `SELECT ticker FROM fmp_fundamentals` as its universe definition → all 89 now treated as canonical

The structural hole: `fmp_fundamentals` has no write protection. Anything in `ticker_fundamentals` can be promoted into it by re-running `snapshot-to-staging.ts`.

**Fix status: patch applied, DELETEs pending approval**

Trigger: manual re-run of `snapshot-to-staging.ts` by previous Claude session when seeding peer-group tickers. No hooks/automation reference it — one-off mistake, no automated re-trigger risk.

`snapshot-to-staging.ts` patched (2026-07-06):
- Startup guard: aborts if `fmp_fundamentals` already has rows, unless `--force` passed
- Update-only: fmp branch skips tickers not already in canonical set (no new inserts)
- Summary line reports how many tickers were blocked from expanding the universe

**❓ Pending DELETE approval** — exact statements ready, awaiting go-ahead:
```
DELETE FROM field_provenance WHERE ticker IN (...89 tickers...);
DELETE FROM source_fundamentals WHERE ticker IN (...);
DELETE FROM ticker_fundamentals WHERE ticker IN (...);
DELETE FROM fmp_fundamentals WHERE ticker IN (...);
```
Full list of 89: ADI ADYEN ANET ARM BB BILL BKNG BMBL BULL COIN COMP CRM CRWD CYBR DASH DDD DDOG DELL DOCU DUOL ETSY FIS FISV FOUR GFS GPN GRAB HPE HPQ INTU IONQ LDI LQDA LUNR LYFT MDB MELI MNDY MRVL MTCH MU NOW NTAP NU NXPI ON ONDS OPEN ORCL PAGS PINS PN POET PYPL QCOM QLYS QSI RDDT RDFN RDW RKLB RKT ROKU RPD S SAP SE SG SMCI SNAP SNOW SOFI SOUN SPCE SPCX SPOT SUPX SWKS TEAM TEM TENB TOST TTD TXN UBER WBD WDAY WOLF ZS

Open questions before executing:
- Clean `yahoo_fundamentals` for these 89 too? (they may have Yahoo data from canonical backfill)
- Clean `source_ticker_map`? (mapping table, not data — lower priority)

---

## Next session tasks

Full task list: `.claude/docs/next-session-tasks-db.md`

1. ~~Confirm whether 257-ticker expansion is intentional~~ → Step 1 complete, awaiting user confirmation
2. Create `canonical-tickers.json` + `validate-universe.ts`; wire scripts to read from it
3. Audit ETF exclusion, FIELD_DEFS duplication, rate-limit constants, peer-group drift, schema comments
4. Wire Polygon/AV into merge-trusted.ts FIELD_DEFS as lowest-priority fallbacks
5. Re-run merge-trusted + dry runs against confirmed universe before any live API call

---

## 2026-07-06 session — DELETE reassessment

**Decision: skip all pending DELETEs. Leave all 257 tickers in all tables.**

Reasoning accepted:
- The 89 peer-group tickers were intentionally added to `ticker_registry` + `peer_group_members` for sector-relative scoring. Their fundamentals data will be needed by the scoring pipeline — deleting now and re-fetching later wastes FMP/AV quota.
- The snapshot-to-staging.ts guard (applied last session) eliminates the re-trigger risk. The structural hole is closed.
- The actual bug was `fmp_fundamentals` acting as the implicit universe definition, not the existence of the data.

**Agreed approach going forward:**
- `canonical-tickers.json` (168 tickers) = primary tracked universe — what the watchlist UI shows, what "our universe" means in docs/monitoring
- `validate-universe.ts` checks that `fmp_fundamentals` contains ALL tickers in this file (superset OK — peer-group tickers are valid extras)
- `merge-trusted.ts` and backfill scripts continue targeting `SELECT ticker FROM fmp_fundamentals` (all 257) — peer tickers need fresh fundamentals for scoring
- Future universe changes require an explicit edit to `canonical-tickers.json`, not incidental row inserts

**Not yet implemented** — user confirmed direction, implementation deferred to next session.

---

## 2026-07-06 session — ticker_registry audit + fetch_fundamentals flag

### Universe source audit

`ticker_registry` alone was not sufficient as the universe source (579 rows — all peer group tickers across all groups). The scripts that appeared to "use ticker_registry" were actually using WATCHLIST (30 tickers from `constants.ts`) + peer_group_members lookup — not a full registry scan. Split was:

- fmpFundamentals (257): merge-trusted, backfill-fmp, backfill-polygon, backfill-av, backfill-yahoo-canonical
- WATCHLIST+peer_group join (30 → ~257): backfill-yahoo, backfill-edgar, backfill-finnhub

Polygon and AV confirmed NOT wired into FIELD_DEFS (cross-validation only). Old notes accurate.

### Resolution: fetch_fundamentals boolean on ticker_registry

**Migration applied (0010_fetch_fundamentals_flag.sql):**
- `ALTER TABLE ticker_registry ADD COLUMN fetch_fundamentals boolean DEFAULT false NOT NULL`
- `UPDATE ticker_registry SET fetch_fundamentals = true WHERE ticker IN (SELECT ticker FROM fmp_fundamentals)` → 257 rows flagged

**Scripts updated — all now use `SELECT ticker FROM ticker_registry WHERE fetch_fundamentals = true`:**
- merge-trusted.ts: removed fmpFundamentals import; added tickerRegistry
- backfill-fmp.ts: two-query pattern (universe from ticker_registry; staleness from fmpFundamentals by ticker); FmpRow narrowed to {ticker, fetchedAt, fmpWacc, fmpRoic}
- backfill-polygon.ts: simple swap
- backfill-av.ts: simple swap
- backfill-yahoo.ts: removed WATCHLIST + peerGroupMembers + inArray; single ticker_registry query
- backfill-edgar.ts: same
- backfill-finnhub.ts: same
- backfill-yahoo-canonical.ts: **deleted** (fully covered by backfill-yahoo.ts with the new query)

**Verified:** `SELECT COUNT(*) FROM ticker_registry WHERE fetch_fundamentals = true` → 257. TypeScript clean after rebuilding lib/db declaration files.

### Adding a new ticker to the fundamentals universe going forward

1. Ensure ticker is in `ticker_registry` (insert if needed)
2. `UPDATE ticker_registry SET fetch_fundamentals = true WHERE ticker = 'XYZ'`
3. All backfill scripts and merge-trusted will pick it up on next run automatically

---

## 2026-07-06 session — fetch_fundamentals lifecycle wired into POST /watchlist

### Finding: two separate "watchlist" concepts

- **Hardcoded `WATCHLIST`** in `constants.ts`: 30-ticker options-signal list (RSI_THRESHOLDS keys). Used by backfill scripts (now replaced) and indicators/technical routes. Static, requires a code deploy to change.
- **DB `watchlist` table**: real per-user watchlist. `POST /watchlist` is what the UI calls when a user adds a ticker. This is the correct hook point.

### What was wired (routes/watchlist.ts POST handler)

1. **Upsert ticker into ticker_registry** with `fetch_fundamentals = true`. Handles both new tickers (no registry row yet) and existing ones (just flips the flag).
2. **Peer group lookup**: queries `peer_group_members` for all groups this ticker belongs to, then sets `fetch_fundamentals = true` for all other members of those groups via a single UPDATE.
3. **No-peer-group warning**: if the ticker has no peer_group_members rows, the API returns `{ ticker, warnings: ["XYZ has no peer group — add it to a peer group and re-run to flag peers"] }` and logs to stderr. No silent handling — caller sees the gap.

### Response shape change (non-breaking)

`POST /watchlist` → `201 { ticker: "IONQ" }` (unchanged for tickers with peers)  
`POST /watchlist` → `201 { ticker: "IONQ", warnings: [...] }` (new field, optional — only present when no peer group found)

### What this does NOT handle

- Removing a ticker from the watchlist does NOT flip `fetch_fundamentals = false` — intentional. Peer group tickers should keep their fundamentals data even if the watchlist ticker is removed; the scoring pipeline needs them.
- The hardcoded `WATCHLIST` in constants.ts is still used by the indicators and technical routes. It is NOT the universe source for fundamentals and should be treated as a separate concern (options signal config).

---

## 2026-07-06 session — FMP budget overage investigation

### Budget status as of investigation
`fmp_api_usage` row: **294 calls today** (reset_date 2026-07-06). Code soft-limit = 220. Actual FMP free-tier limit = 250. Both exceeded.

### Source 1 (primary, counted): server startup in index.ts
On every server restart, `index.ts:37-43` calls `getStaleTickers(WATCHLIST)` → `refreshFundamentals(stale)`. Fires 7 FMP calls per stale WATCHLIST ticker (30-ticker hardcoded list) and records via `recordFMPCalls`. Up to 210 calls per restart. **Critical bug: startup path does NOT call `checkFMPBudget` first** — bypasses the gate that `POST /fundamentals/refresh` uses. This is why 294 exceeded both limits; multiple restarts fired without budget awareness.

### Source 2 (secondary, uncounted): stock breakdown route
`GET /stocks/:ticker/breakdown` fires one raw `fetch()` to `financialmodelingprep.com/stable/price-target` per page view. Never routed through `recordFMPCalls`. Invisible to the budget tracker. Real FMP usage today is higher than 294.

### APA clarification
APA's `fmp_fundamentals.fetched_at` = 2026-06-26 — not today. User misread the timestamp. No unexplained fetch occurred for APA today.

### Two separate pipelines (independent, both spend quota)
- Startup `refreshFundamentals` → `ticker_fundamentals` (legacy gold table), 30-ticker WATCHLIST
- `backfill-fmp.ts` → `fmp_fundamentals` (new staging table), 257 tickers via `fetch_fundamentals` flag

### Action items (not yet implemented)
- Add `checkFMPBudget` gate to the startup `refreshFundamentals` call in `index.ts` — prevents restart-triggered overages
- Add `recordFMPCalls(1)` to the price-target fetch in `stocks.ts` — makes breakdown calls visible to the tracker
- **Do not restart the server today** — quota already exceeded, restarts will fire stale-ticker refresh again

---

## 2026-07-06 session — Phase 0: FMP budget bleed fixes (COMPLETE)

### External API call inventory (full codebase scan)

| Call path | FMP? | Counted via recordFMPCalls? | Gated by checkFMPBudget? |
|---|---|---|---|
| `fetchFMPFundamentals` via fmp-client | Yes | Yes | Yes (backfill scripts + POST /fundamentals/refresh) |
| Startup `refreshFundamentals` in index.ts | Yes | Yes (records after) | **No — FIXED** |
| `price-target` fetch in breakdown route (stocks.ts) | Yes | **No — FIXED** | No (tracking only for now) |
| CNN Fear & Greed (macro-data.ts) | No | N/A | N/A |
| NY Fed GSCPI Excel (macro-data.ts) | No | N/A | N/A |
| SEC EDGAR — CIK + company facts (stock-data-manager.ts, edgar-client.ts) | No | N/A | N/A |
| Finnhub (finnhub-client.ts) | No | N/A | own rate limiter |

### Fix 1: Startup budget gate (index.ts)

Added `checkFMPBudget(stale.length * 7)` before `refreshFundamentals` in the startup path. Three cases handled:
- Budget check throws → logs warning, skips refresh, server continues normally (fail safe)
- Budget exhausted → logs warning with callsNeeded/callsToday/remaining, skips refresh
- Budget available → proceeds as before (no behavior change)

### Fix 2: Price-target call tracking (stocks.ts)

Added `recordFMPCalls(1).catch(() => {})` via `.finally()` on the breakdown route's price-target fetch. Records regardless of fetch success/failure. Failure to record never propagates to the response (fail safe).

### Current budget state
294 calls recorded for 2026-07-06. A restart now will log "startup: FMP budget exhausted — skipping stale refresh" and stop. No further overage possible from restarts today. Budget resets at midnight UTC.

### TypeScript: clean (one pre-existing error in backfill-edgar.ts unrelated to this phase)

---

## 2026-07-06 session — Phase 0 close-out

### Item 1: Silent catch now logged
Added `logger.warn({ err }, "stocks: failed to record FMP price-target call")` inside the `.catch()` on `recordFMPCalls` in stocks.ts. Failures are no longer invisible.

### Item 2: Polygon and AV call path audit

**Polygon (`polygon-client.ts` + `backfill-polygon.ts`):**
- Only call site: `backfill-polygon.ts` (no route imports `polygon-client`)
- Rate enforcement: concurrency=3 + 1s sleep between batches (soft throttle matching 5 req/min free tier). On HTTP 429, retries with backoff. No proactive daily call counter or DB-backed gate.
- Assessment: adequate for a script run manually, but no hard enforcement if the free tier's daily request cap is hit. **Not a high-risk ungated path** — script is only run deliberately.

**Alpha Vantage (`alpha-vantage-client.ts` + `backfill-av.ts`):**
- Only call site: `backfill-av.ts` (no route imports `alpha-vantage-client`)
- Rate enforcement: `logs/av-cursor.json` tracks `callsToday` against `MAX_DAILY_CALLS = 25`. Hard stop fires before any call once `callsToday >= 25`. AV API also returns `Information`/`Note` fields on limit hit, caught and thrown.
- **Risk: cursor is a flat file.** If the log directory is missing, rotated, or the script runs from a different working directory, the gate resets to 0 and the full 25 calls fire again. This is Phase 1 research scope.

### Item 3: Price-target fetch gating status
**Intentionally ungated for now (tracking only).** The breakdown route fires one price-target call per stock detail page view. Now tracked via `recordFMPCalls(1)`. Whether to gate it behind `checkFMPBudget` is a Phase 1 decision — it requires first consolidating the FMP budget check so it's shared across both the breakdown route and the startup/backfill paths, which is part of the access-layer design.

### Phase 1 + 2 scope (not built now)
**Phase 1 (research):** For each of FMP, Polygon, AV, Finnhub, Yahoo, EDGAR — document exactly how usage is currently tracked (DB table / flat file / in-memory / none), what the actual limit is, and whether it's enforced before calls or only recorded after.

**Phase 2 (design):** As part of the `getFundamentals()` access-layer, spec a single `api_usage` table (columns: source, date, calls_made, limit, window) that every source's client writes to through one shared function. The Stock DB-adjacent UI subtab ("API Usage") reads from this one table. No ad hoc dashboard built on top of four inconsistent tracking mechanisms.

**Phase 0 is closed.**
