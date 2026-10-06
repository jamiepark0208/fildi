# Fildi → Robinhood watchlist sync

**Goal:** open Robinhood and see Fildi's current calls already organized into `Fildi ·` watchlists. A recommendation reaches Robinhood only after passing two verification layers.

Inputs come from Fildi tables (model_recs, scores, technicals) and from LSEG / WRDS research data. Anyone (Claude Code or Cursor) may change it; see root AGENTS.md "One team".
**Status:** Phase 1 = **plan + verify only. Nothing is written to Robinhood yet.**

## Pipeline
```
build_plan.py      L1: Fildi-data checks → watchlist_sync.plans / plan_items   (no vendor calls)
verify_plan.py     L2: live Robinhood checks (read-only MCP, piped JSON)        → verify_status per item
fit_model.py       verdict + role per ticker → fit_scores (latest) + fit_score_history (append-only)
publish_model_list.py  plan + fit → model_runs / model_items → app Watchlist → Model List (read-only, user 1)
(Phase 2) apply    diff → only "Fildi ·" lists by stored list id; caps; log    (Claude session, ask-first)
```
**Plan of record:** `PLAN.md`. **Test harness:** the app's Watchlist → Model List tab (folders like RH lists). Model tags never write `watchlist.color_tag`.
Planned trigger: export prompt → Step 12 ingest → **Step 13 build_plan** → **Step 14 verify + apply**, so one click per day covers both.

## Lists
| key | Robinhood list | phase | source |
|---|---|---|---|
| sell_puts | Fildi · Sell Puts | 1 | model_recs puts |
| sell_calls | Fildi · Covered Calls | 1 | model_recs calls on **free** shares (held − 100 × open short calls, per account) |
| trim_risk | Fildi · Trim / Risk | 1 | held names with ≥2 independent red flags (LSEG credit/ARM/CAM/pred-miss, falling knife) |
| earnings | Fildi · Earnings Setups | 2 | reports ≤7d + RICH premium verdict |
| buy | Fildi · Buy | 3 | after Cursor score upgrades |
| long_calls / long_puts | — | 4 | needs a graded directional model |

## Verification (all thresholds in `rules.py`)
**L1, Fildi data (block unless noted):** snapshot ≤1 trading day old · live bid · delta band (0.00 = broken greeks) · 2–45 DTE · IV sane · premium ≤10% of strike · ≥0.30%/week · model spot vs latest close ≤3% · no earnings (earliest of LSEG/app) before expiry · puts: StarMine credit ≥20, not falling knife, **collateral fits an account's unleveraged buying power** · calls: ≥100 **free** shares in one account · warn: stale model spot, existing exposure, unknown earnings/credit.

**L2, live Robinhood (block unless noted):** contract exists, active, tradable · quote fresh (≤20 min in session; after hours = latest close, status `pass_after_hours`, **must re-verify in session before apply**) · bid > 0 · spread ≤30% of mark **or** ≤$0.05 · **realistic fill (RH `high_fill_rate_sell_price`) ≥85% of Fildi premium** · OI ≥100 or volume ≥25 · still ≥2% OTM at live price · RH delta in band · warn: live spot drift >3%, IV disagreement >35%.

## Run
```bash
cd scripts/watchlist_sync && .venv/bin/python build_plan.py --show-rejected
.venv/bin/python verify_plan.py requests          # what to look up on Robinhood
# Claude session (read-only MCP): get_option_instruments per contract, get_option_quotes (≤20 ids/call),
# get_equity_quotes → pipe each response:
.venv/bin/python verify_plan.py ingest instruments < resp.json   # also option_quotes / equity_quotes
.venv/bin/python verify_plan.py evaluate
```

## First run: 2026-10-04 (plan #2, Friday-close quotes)
- L1: 67 put / 51 call ideas → 15 / 1 (+4 trim). Blocked mostly by: no free shares (50), collateral doesn't fit (32), spot drift (24), credit (13), falling knife (10), broken delta (7), earnings before expiry (4). L1 also caught that HOOD was already fully covered by open short calls.
- L2: 16 contracts → **4 pass** (TTD 11.5P, NFLX 65P, RIG 5P, POET 8.5C). Rejections: realistic fill 16–35% below Fildi's premium (POET P, SOFI, OXY, DVN, ETSY), spreads 38–156% (MNDY, CAVA, ETSY, BEAM, TPG, PYPL, OXY, HPQ, LUMN), thin OI (CAVA, LUMN).
- Upstream findings (reported to Cursor): 64/97 model_recs on 10/02 used the 10/01 close as spot; premiums use Yahoo bids, which overstate realistic fills; `data_quality` is always 1.00.

## Changelog
- 2026-10-05 (close-out): Model List health strip (API `health`), Manage open by default, render verified via Vite SSR.
- 2026-10-05 (consolidation): one live fit model (`fit_model_v14.py`; fit-1.3 = input builder only); learn.py runs only on new
  evidence; grades use one run per day; `rh_client.py` = deterministic Robinhood MCP client (no AI) for L2; LSEG RIC validation by
  price on Fildi's last date + TR.PriceClose fallback for RICs the time-series service rejects.
- 2026-10-05 (portfolio v2, user review): capacity = free cash BP + collateral already posted on open short puts; fund new puts from free
  cash, else by closing open puts that earn ≥10% less per week on their collateral (listed in Manage); concentration/sector limits are
  soft warnings ("limit" badge), feasibility is the only hard limit; unfundable ideas say when expiring puts free the cash. Yield floor
  0.35%/wk realistic (≈ scanner 0.50%/wk on Yahoo bids) as `thresholds.min_weekly_realistic`.
- 2026-10-05 (latest): champion fit-1.4.1 (auto-promotion within bounds, delegated by the user). Step 7 portfolio layer in the
  Model List: ideas share one collateral budget, sized per account; calls below cost basis held back; new Manage folder.
- 2026-10-05 (later): fit-1.4.0 champion from `model_params` (user-approved Step 4 proposals); Model List publishes from the champion
  (severity-weighted put cross-check `put_block_risk`, regime pause, latest *verified* plan). `learn.py` proposes challengers from
  evidence; `daily.py` runs everything; `split_repair.py` fixes unadjusted splits.
- 2026-10-05: fit-1.3 (verdict separate from role; held names keep their real verdict; plan tickers always scored; fit_score_history ledger). `publish_model_list.py` + app Model List tab. Verdict cross-check: sell_puts needs not-red, no flags, OWN ≥ 45 → otherwise Needs Review (run #1 held back TTD).
- 2026-10-04: Phase 1 (L1 + L2). Spread rule = pct **or** ≤$0.05 absolute (cheap options are a few ticks wide at best).

## Fit model (color tags) — `fit_model.py`
Pillars 0–100: **OWN** (fund 45% · StarMine credit 35% · CAM 20%; credit dropped for levered financials) · **STREET** (ARM 50% · 30d EPS drift 25% · predicted surprise 25%) · **PREMIUM** (LSEG IV ÷ realized 60% · IV level 40%) · **FIT** (10%-OTM put collateral vs your cash/margin buying power; <$3 capped) · **EDGE** (your realized $ per ticker).
Flags: credit ≤15 · ARM ≤15 · fund ≤35 · falling knife · short ≥25% float · predicted miss with ER ≤30d · implausible PT.
Colors: purple ETF/context · blue held · red ≥2 flags or OWN&STREET <35 · green OWN≥62 & STREET≥55 & credit≥40 · yellow PREMIUM≥55 & OWN≥45 & FIT≥60 & no flags (**provisional if IV captured off-hours**) · else untagged.
- v1.1 2026-10-04: credit excluded for banks/asset managers/BDCs/insurers (GS 11, PFLT 1 = model artifact); effective peer group honors overrides; coverage lookalikes included as new ideas.
- v1.2 2026-10-04: premium from LSEG IMP_VOLT, not Fildi Yahoo IV (7/8 v1.1 yellows were IV artifacts); yellow provisional off-hours (LSEG IV also drifted Sunday night).
