# TradeDash Mac-local VERIFY — works vs works-best
> Started 2026-10-05. Evidence from live stack + `/tmp/fildi-logs` + Postgres.
> Grades: **PASS** · **WARN** · **FAIL** · **UNKNOWN** (needs browser/login).
> Two bars: **Works** = job fires / feature loads. **Works-best** = data quality, freshness, UX density, no silent debt.

---

## A. Scheduled / ops inventory (complete catalog)

### LaunchAgents (launchd)
| ID | Schedule (PT) | Works (2026-10-05) | Works-best |
|---|---|---|---|
| `com.fildi.maintain` | 7:00 AM full | **PASS** — loaded; `maintain-last.json` 07:01 PT; `ok/processOk/vendorsOk=true` | **WARN** — see FactSet 93% + needs_review 548 + drain skipped |
| `com.fildi.stack-ensure` | 12:00 + 2:45 PM heal | **PASS** — loaded | **PASS** if API/Vite stay up midday (heal-only; no enrich) |
| `com.fildi.rbh-export-prompt` | Weekdays after close (prompt) | **UNKNOWN** (supervised Claude MCP) | Only “best” if CSVs land same day |
| `com.fildi.rbh-daily-export` | Weekdays ~3:00 PM + WatchPaths ingest | **UNKNOWN** until today’s CSVs checked | Blocked if Export stage missing |

### API scheduler (in-process; needs API up)
| ID | Cadence | Works | Works-best |
|---|---|---|---|
| Session Regime ×11 | Weekdays 6:45a–12:00p | **UNKNOWN** without Settings UI / Live banner | Best = all due checkpoints resolved with direction+confidence |
| Event Bullets | ~7a with Maintain precompute | **PASS** if `morning_precompute_exit_0` (today yes) | Best = watchlist names have fresh bullets on Breakdown |
| Earnings History Backfill | ~7a drip ≤60 | **PASS** stamped via morning precompute | Best = 0 writes most days (normal); backlog not growing |
| FMP Analyst Feed | ~7a global tape | **PASS** via morning precompute | Best = Breakdown analyst actions show FMP sources |
| Desk Commentary Ingest | ~every 25m | **PASS**-ish — 66 desk rows in 2d | Best = ingest &lt;2h old always; Apps Script both accounts |
| Schwab Auth Health | ~every 6h | **UNKNOWN** (config-dependent) | Best = refresh token ≥2d left; access auto-refreshes |
| Research Ops Health | ~every 6h | **UNKNOWN** (401 without session) | Best = wrds/lseg overall ok; desktop :9000 when syncing |
| Option Score Snapshots | Mon–Thu ~12p | **WARN** — DB max `as_of=2026-10-04` (Sun); Mon not due yet | Best = Mon–Thu as_of = trading day; live bids high |
| Model Snapshot | Fri ~12p | **PASS** for weekly — last `2026-10-02` Fri, not degraded | Best = every Friday noon while API up |
| Model Grade + Expiry | Fri eve / Sat | **UNKNOWN** this week | Best = track-record grades update weekly |

### Supervised (not LaunchAgent — by design)
| ID | Cadence | Works | Works-best |
|---|---|---|---|
| LSEG Daily Sync | Weekdays after open | **PASS** freshness — signals/events `2026-10-04` &lt;2d | Best = run Mon morning after Workspace up |
| LSEG Weekly Sync | Weekly | **PASS** — coverage/ids/holders/etc Oct 4 | Best = Sunday pack when desktop on |
| WRDS Monthly IBES | Monthly | **PASS** — ibes_* `2026-10-04` | Best = early-month Duo session |
| WRDS Quarterly CRSP | Quarterly | **PASS** — crsp_dsf Oct 4 | Best = after WRDS CRSP updates |
| AI / Cursor Workflow Review | Sun ~6p | **UNKNOWN** | Best = measurable token Δ in review JSON |

### Maintain sub-actions (inside 7a full)
Today’s actions (evidence): enrich_missing ok · enrich_earnings skipped empty window · enrichment age 1.0d · drain_nr **skipped** (FactSet rem 37 &lt; 60) · peer_health ok · post_merge scores 578 + **snapshots 578** · retention prune · morning_precompute · anomalies flagged.

---

## B. Live evidence snapshot (2026-10-05 morning)

| Signal | Value | Grade |
|---|---|---|
| API `:8080` / Vite `:8081` | HTTP 200 | PASS |
| Maintain report | ok, 9/0 health | PASS |
| Gold fund scores | 567 / 579 | WARN (12 unscored) |
| `fund_score_snapshots` | 578 tickers, as_of today | PASS (history bootstrapped) |
| Option score snapshots | 382 rows, max 2026-10-04 | WARN (confirm Mon–Thu fire) |
| Desk commentaries (2d) | 66 | PASS volume |
| `ticker_registry` null peer | 242 total; join-to-gold TBD | WARN |
| Peer health | 49 groups, 10 overrides, unmappedQueue 8, keywordMismatch many | WARN |
| FactSet budget | 463/500 (92.6%) | **FAIL for “best”** — drain blocked |
| needs_review anomaly | 548 | **FAIL for “best”** |
| Field fill | 97.6% | PASS |
| WRDS/LSEG sync_state | All refreshed Oct 4 | PASS |
| Model snapshot | Fri Oct 2, degraded=false | PASS weekly |

---

## C. Product surfaces — works vs works-best

### C1. Platform / efficiency
| Item | Works | Works-best / honest gap |
|---|---|---|
| Local stack (no Replit) | PASS | PASS — LaunchAgents + maintain are the right Mac pattern |
| Shared Haiku + aiLimiter | PASS (code) | Best = Settings AI usage shows tokens; no surprise burns |
| Query-key sharing | PASS (code) | Best = Network tab shows one `technicals/all` per session |
| DISABLE_SCHEDULER_ENRICHMENT | PASS | Correct — avoid double enrich vs maintain |

### C2. Research lanes
| Item | Works | Works-best / honest gap |
|---|---|---|
| WRDS IBES → fund growth | PASS (code + recent sync) | Best = Street Event Risk + Growth moves when IBES stale; calibrate thresholds |
| LSEG soft UI | PASS dig sheets | Best = desktop up on sync days; never silently into fund_score (OK today) |
| Research Ops Health | Code PASS | Best = Settings row green every 6h; desktop warn when Workspace closed |
| Universe book ≤50 | Contract | Best = book hits in Daily News match your real book |

### C3. Scoring / peers / Stock DB
| Item | Works | Works-best / honest gap |
|---|---|---|
| Persisted fund_* | PASS 567 scored | **Not best** while 12 unscored + FactSet drain starved |
| Snapshots + notes | PASS tables + 578 today | Best = ≥2 days history before trusting chart; notes used by you |
| Peer overrides | PASS (10 overrides) | **Not best** — keywordMismatch (AMZN/MSFT/SHOP…) = cohort noise for relative scores |
| needs_review 548 | Feature exists | **FAIL best** — almost whole book flagged; provenance UI underused |
| Peer unmapped queue 8 | PASS tracked | Clear those 8 manually |

### C4. Live
| Item | Works | Works-best / honest gap |
|---|---|---|
| Hotlist dip/rally | PASS (code) | Best = accuracy chip vs reality; no stale quotes |
| Desk ingest + Daily News | PASS volume | Best = dig facts ticker-specific; tape 1-line (**fixed**); Haiku not stale vs new emails |
| Regime checkpoints | Needs market hours | Best = 11/11 resolved on trading days while API up |
| Watchlist Options expand-only | PASS (code) | Best = no batch on load (efficiency) |

### C5. Options / accountability
| Item | Works | Works-best / honest gap |
|---|---|---|
| Shared option-scoring | PASS | Best = side-aware + streetEventRisk calibrated |
| Option snapshots | WARN cadence | Best = Mon–Thu noon stamp every trading day |
| Model snapshot Fri | PASS last Fri | Best = never miss Friday (API must be up) |
| Schwab MD | Config-dependent | Best = linked + refresh &gt;2d; else Yahoo-only is second-best |

### C6. Breakdown (post-prune)
| Item | Works | Works-best / honest gap |
|---|---|---|
| Fund header = rankings | PASS design | Best = spot-check NVDA/AAPL totals match Home |
| Peers Tot/Fnd/V/G/Q/S/Tech | PASS | Best only if peer groups clean (keywordMismatch hurts) |
| Street synthesis + digs | PASS | Best = conflicts rare & ticker-specific; glossary stays behind ? |
| Yahoo news only | PASS | Best = yes for this page |
| TV/Accounting sheets | PASS | Best = dig, not main path — done |
| Score history | PASS empty→seeded | Best after a week of daily snaps |

### C7. Portfolio / Profile / Macro / Settings
| Item | Works | Works-best / honest gap |
|---|---|---|
| RH export→ingest chain | UNKNOWN today | Best = CSVs 3/3 then ingest green same weekday |
| Portfolio server-backed | PASS (code) | Best = positions match RH after ingest |
| Macro tabs | PASS (code) | Best = charts cache fresh; regime matches Live |
| Feedback / auth / Stock DB | PASS (code) | Best = Stock DB used to burn down needs_review |

---

## D. Top gaps ranked by “not best” impact

1. **FactSet at 93% + drain skipped** → needs_review pile (548) cannot clear → gold quality stalls.
2. **Peer keywordMismatch / unmapped queue** → relative peer scores on Breakdown/Rankings are partly wrong cohort.
3. **12 unscored fund names** → rankings/Breakdown incomplete for those tickers.
4. **Model / option snapshot cadence** depends on API up at noon — easy to miss if machine sleep.
5. **RH export still supervised** — portfolio freshness is human-gated.
6. **Research desktop / Duo** — LSEG/WRDS freshness is manual; health probe helps but doesn’t sync.
7. **Breakdown UX** — pruned, still not “terminal dense”; peers better, but TV dig + equal secondary panels remain.

---

## E. Recommended VERIFY path (complex)

### E0 — Ops (15 min) — do first every morning
1. Settings → Scheduled Tasks: Maintain **ok**, heal agents loaded, desk ingest &lt;2h, research-ops not failed.
2. Open `/tmp/fildi-logs/maintain-last.json`: `ok`, `anomalies`, FactSet remaining.
3. If FactSet remaining &lt;60: **do not expect** needs_review drain today — plan tomorrow or raise limit.
4. Peer-health: unmappedQueue → 0; spot-check 3 keywordMismatch (accept or override).

### E1 — Data truth (20 min)
1. Stock DB: gold coverage, fund_score coverage, needs_review count trend ↓.
2. Pick 3 tickers (mega / bank / speculative): fund total Home = Breakdown header.
3. Peers table: subject highlighted; V/G/Q/S populated; click peer navigates.
4. After IBES sync week: Growth family moves with breadth/SUE on a name with revisions.

### E2 — Live + desk (15 min)
1. Daily News: tape **one line** SPY·QQQ·VIX·TNX; Generate/Refresh; dig cards cite tickers.
2. Session inbox shows both account sources if dual-labeled.
3. Hotlist both sides; regime checkpoint after a due slot.

### E3 — Options + accountability (15 min)
1. Scanner put/call; expand chain only on click.
2. Mon–Thu: option_score_snapshots as_of = today after noon.
3. Friday: model-snapshot-last.json fresh; track-record updates after grade job.

### E4 — Research supervised (when Duo/desktop available)
1. LSEG: Workspace :9000 → sync_signals + sync_events if &gt;1 trading day stale.
2. WRDS: monthly IBES if &gt;30d; confirm Street WRDS dig non-empty on book name.

### E5 — Portfolio (weekday PM)
1. RH export CSVs 3/3 → ingest LaunchAgent green → Portfolio matches.

---

## F. Verdict (honest)

**Works (as a Mac-local system):** Yes. Stack up, Maintain healthy this morning, scores+snapshots wrote, research caches fresh as of Oct 4, desk flowing.

**Works best:** No — not yet. And the first VERIFY pass **misread** FactSet: Maintain’s 463/500 was a **stale `data_sources.calls_today` from 2026-09-28** (never reset). Settings API Monitor `0/500` was correct (`api_usage` has no FactSet row today). That false “budget exhausted” caused **drain_nr skipped** and a fake anomaly.

**Priority to “best”:** (0) **Unify budget SoT** — done in maintain + factset-referee (api_usage; maintain resets data_sources daily), (1) re-run drain NR with real remaining ~500, (2) peer mismatch triage, (3) noon snapshot cadence, (4) RH export, (5) Breakdown density.

---

## H. Tracking honesty (2026-10-05 discovery → fixed same day)

**Fixes shipped:** api_usage single SoT + alias `alpha_vantage→av`; removed dual `recordApiUsage` beside `logApiCall`; FMP logs 9 units/fetch; on-demand enrich defaults to free sources only; local-stack soft-adopts pidfiles; Schwab status refreshes access + distinguishes env missing.

**Orphan API watcher (2026-10-05 afternoon):** Stale `tsx watch` (PPID=1) reclaimed `:8080` without `SCHWAB_*` → Settings “env missing” yellow while a good watcher sat idle. Fix: `local-stack down/heal` kills stray api tsx-watch; `load-env-local.ts` fills missing keys at boot; `dev-restart` passes SCHWAB_* explicitly. Options path is Schwab-first / Yahoo-fallback (Yahoo does not overwrite a successful Schwab chain).

## H0. Tracking honesty (pre-fix discovery)

| Counter | What Settings shows | What Maintain used (before fix) | Truth |
|---|---|---|---|
| FactSet | `api_usage` → **0 today** | `data_sources.calls_today` → **463 stale** | Monitor correct |
| FMP | `api_usage` **6 today** | `data_sources` **0** (never incremented there) | Monitor correct |
| AV | source key `av` | `data_sources` name `alpha_vantage` | name mismatch |
| Reset path | n/a | only nightly-enrichment / SDM | **not on Maintain** → rot |

**Also not fully tracked in API Monitor:** Schwab (separate status strip), Yahoo/Polygon often undercount if calls bypass `recordApiUsage`/`api-logger`, WRDS (research sync_state only), Anthropic (ai_usage_log).

---

## H1. Monitor stale errors + enrichment stamp (2026-10-05)

**User still saw:** WRDS `pends` UndefinedColumn, LSEG `unresolved: ['POET']`, Data Health “Last enrichment: 9/26”.

**Root causes (not one-offs):**
1. `pull_log.error` kept soft/partial misses forever; Settings showed them even after a later `sync_state.last_ok_at`.
2. LSEG `sync_ids` wrote every unresolved ticker into `error=` (POET is CA-ISIN on NASDAQ — now mapped; soft misses expected).
3. Data Health / app_config lagged Maintain’s `enrichment_runs` (Maintain did write runs; UI/API must read runs SoT).

**Durable fixes:**
- WRDS `sync_ibes.py` introspects `tr_ibes.surpsum` columns (never assume `pends`).
- `research-ops` `latestPullError`: only `status=error`, ignore `unresolved:%`, only if newer than `last_ok_at`.
- LSEG `sync_ids`: soft miss (≥95% resolved) → notes only, advances `last_ok`; hard miss → error.
- Data Health route + scheduler hydrate from `enrichment_runs`.
- Maintain: `enrich-unscored-fundamentals.ts` daily free enrich; fund score coverage counts **active** only (fetch=true, not ETF); anomaly `unscored_active_N` if N>8.
- post-merge JSON lists unscored + reason (`coverage_below_0.4` / `post_gate_unranked`).

**VERIFY unscored (2026-10-05):** 11 null totals after rescore — 6 are fetch=false (acquired/dead/ETF DRAM); **5 active** (BITF, CMA, CYBR, HBI, MMC) fail coverage/safety gates honestly (not “forgot to score”). Free enrich + Maintain path will keep trying; do not lower `TOTAL_MIN_COVERAGE` to fake green.

**NR:** drain batch −52 → ~496 divergent (under anomaly ceiling 500); Maintain drains when FactSet rem ≥60.

)
