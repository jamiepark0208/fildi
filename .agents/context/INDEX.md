# TradeDash context — retrieval map (shared)
> Cursor + Claude. Read **only** what the task needs. Prefer codegraph for code.

## Always-injected (tool-specific — do not merge these files)
| Tool | File | Role |
|---|---|---|
| Cursor | `.cursor/context/cursor-state.md` | Phase / next tasks — **Cursor writes** |
| Cursor | `.cursor/context/session.md` | Last Cursor session notes |
| Claude | `.agents/context/state.md` | Phase / next tasks — **Claude writes**; Cursor **read-only** |

## By topic (pick one)
| Topic | Canonical file | Do not open first |
|---|---|---|
| Agentic floors | `.agents/context/agentic-floors.md` | `.cursor/tasks/ai/1-*` full research PRD |
| Sector / peer scoring | `.agents/context/plans/fundamental-sector-scoring.md` | `.cursor/context/archive/` · `.cursor/plans/archive/` |
| Fund-score treatments (profit/financial/style) | `.cursor/context/plans/fund-score-treatment-framework.md` | — |
| Free API field inventories (CET1/FFO gaps) | `.agents/context/data-source-fields/INDEX.md` | — |
| **Which API endpoints our keys can call (all sources, probed)** | `.agents/context/data-source-fields/endpoint-entitlements.md` | Re-researching vendor docs |
| Desk commentaries (any labeled email → Live Daily News, JSON-only Drive) | `.agents/context/desk-commentaries.md` | — |
| Schwab Market Data (options/quotes P0, RPM + 7d refresh) | `.agents/context/schwab-market-data.md` | — |
| Efficiency (AI tokens, RPM, drift, compute) | `.agents/context/efficiency-playbook.md` | — |
| WRDS academic batch (IBES/CRSP + W1–W4) | `research/wrds/PLAYBOOK.md` | Scores only via IBES growth extras; FinRatios/calibration offline |
| LSEG ↔ WRDS research split (shared plan) | `research/LSEG_WRDS_SYNC.md` | **§11 mutual impact** + **§13 ops** before editing |
| Research ops health (WRDS/LSEG cache + desktop) | `GET /api/research/ops` · `research/common/health.py` · Scheduled Tasks **Research Ops Health** | Probe only — never auto-sync vendors |
| LSEG research | `research/lseg/PLAYBOOK.md` | Soft UI only — never fund_score |
| **Research studies / backtests (what we already know)** | `research/studies/INDEX.md` → `METHODS.md` → **`PLAYBOOK.md` (how to run a backtest: tables, s045 harness, checks)** | Re-deriving a study; `out/**` data files |
| Watchlist recommendations / Model List | `scripts/watchlist_sync/PLAN.md` → `NEXT_SESSION.md` | Model tags never write `watchlist.color_tag`; no Robinhood writes |
| Shared research universe (≤50 tickers) | `research/common/universe_book.txt` | Do not duplicate it |
| WRDS → fund growth (IBES breadth/SUE) | `fund-score-engine` + `wrds_research` | Soft UI: Breakdown Street panel; options ER haircut |
| Stock DB quality / NR | `.agents/context/stock-db-best-realistic.md` | Archived quality-audit snapshots |
| Fundamentals cadence | `.agents/context/fundamentals-refresh-cadence.md` | — |
| Earnings-window triggers | `.agents/context/event-driven-refresh.md` | — |
| Derived PEG/formulas | `.agents/context/derived-metrics-framework.md` | — |
| Data-ops value log | `.agents/context/data-ops-value-log.md` | — |
| **TradingView indicators (UT Bot, SuperTrend cluster/div, SMC, Fear & Greed): built, tested, use-case map** | `.agents/context/indicators.md` | Re-implementing indicators; rules from S102 alone |
| **Unique features + how to synthesize overlapping analysis** | `.agents/context/fildi-feature-synthesis.md` | `FACTOR_MAP.md` (factors only); reels → ASKS |
| API catalog | `.agents/context/api-endpoints.md` | — |
| Workflow / build | `.agents/context/workflow.md` | — |
| Agent routing | `.agents/AGENTS.md` | — |
| Muse AI (live remote; Cursor owns handoffs) | `MUSE.md` · ASKS `Muse → Cursor` · pull `origin/cursor/mac-dev` | Cursor implements Muse rows (2026-10-07); Claude plan-reviews every Muse row (2026-10-14) + reviews quant commits (AGENTS.md § Review loop). ASKS = index + `research/common/asks/A##.md` |
| Weekly ops checklist | `.cursor/skills/weekly-data-ops-check.md` | — |
| Cursor lessons (grep) | `.cursor/context/lessons.md` | `lessons-archive.md` unless needed |
| Claude memory (grep) | `.agents/memory/MEMORY.md` | Load whole memory dir |

## Daily maintain (code SoT)
`scripts/maintain.mjs` → missing / earnings / drain / peer-health / post-merge-scores / retention / morning precompute · LaunchAgent `com.fildi.maintain` · report `/tmp/fildi-logs/maintain-last.json`
Late-open (≥10:00 ET, no dataDone): prices+earnings → Model List → heavy (A236). Precompute: A114 repair 1×/ET-day; earnings morning cap 25 (watchlist+window first); street_pt LSEG 45d.  
**Schedule (A229, 10-21):** every 30 min while awake; chain once per ET day from 05:00 PT (≤ 3 attempts, lock, day state `maintain-day.json` with `dataDone`); Model List ≥ 07:00 PT; option history + research queue after the final list; OpenJev freeze waits for the chain; transcripts 08:00 PT. Change any job → log it in A229.  
**Sunday:** also `weekly-data-ops-check.mjs --digest-only` (audit + value-log; no second FactSet drain).  
**Fail notify:** macOS `osascript` banner when Maintain hard-fails.  
**Ops cockpit:** Settings → Scheduled Tasks — **Ops Nucleus** (L0/L1 + 7 workers MetricCards) + Today + alerts + inventory. Phase B/C parked. Research LSEG/WRDS stay supervised (no vendor cron).  
Records into `enrichment_runs` (trigger=`maintain`) → Stock DB **Pipeline Health**.  
Full catch-up engine: `nightly-enrichment.ts` only when ≥4d (via maintain) — **not** a second calendar job on Mac (`DISABLE_SCHEDULER_ENRICHMENT=1`).  
Technicals/options: **not** scheduled (ad-hoc on click).  
Weekly agent skill: `.cursor/skills/weekly-data-ops-check.md` — prefer digest / Maintain-covered skip over re-drain.

## Ignore / archive
| Path | Why |
|---|---|
| `.cursor/plans/archive/` | Stale snapshots + duplicate plan export |
| `.cursor/context/archive/` | Old v1 plan stub |
| `.cursor/tasks/**` | PM backlog — not runtime SoT |
| `.claude/docs/phase-report*` | Claude historical handoffs — only if that task |
| `FUNDAMENTAL_WATCHLIST` | Removed from TS — do not re-add |

## Adapters
| Tool | Entry |
|---|---|
| Shared ToC | `AGENTS.md` (repo root) |
| Claude | `CLAUDE.md` |
| Cursor | `CURSOR.md` + `.cursor/rules/` |
| Skills | `.claude/skills/` (one at a time) |
| Agent workflow / token efficiency (W-registry, audit, startup digest) | `.agents/context/workflow-learning.md` · `scripts/workflow_audit.py` · `scripts/agent_start.py` |
- **Recurring bugs** → `.agents/context/recurring-bugs.md` (B1–B8: stand-in 0s, two pickers, ticker joins, step order, units, reference gates, unpropagated verdicts). Read before fixing recs/scores/surfaces.
