# Fair value — round 3 plan (Jamie 10-27 late) — START HERE

**Full plan: `DCF_PLAN.md` (section by section, phases 1–9). Start with phase 1.**

**Goal (Jamie):** fair value built the way an analyst builds it — explicit per-stock assumptions (growth, margins,
reinvestment, discount rate, terminal growth) with sector defaults taken from published practice, stock overrides where a
company doesn't fit its sector (PLTR), and street targets used carefully (live, median, weighted by sample size).
Judge = sensible + explainable + stable, **not** "match the price". fv-1.2.0's street weight is a stopgap.

1. **Street targets.** Today: LSEG `pt_mean` (mean, no count, no dates); per-broker targets with dates only for 196
   names (`analyst_events`, median 4 brokers live in 90 d). Fetch per-broker targets + dates, median, count, high/low
   for the universe from LSEG after the Nov 1 budget reset. Rules: drop targets older than ~6 months or set before the
   last earnings; median; recency weight; weight shrinks with n (n = 1 small, n ≥ 10 full); dispersion → confidence.
2. **Sector playbook.** Web research (Damodaran, McKinsey *Valuation*, Morningstar methodology, CFA, sell-side
   primers) per sector: main method, key ratio, normal growth/margin/terminal. Table: practice vs our method → gaps.
3. **Class-style DCF (FCFF).** Revenue path (consensus 2–3 yrs → fade to terminal over 10), operating margin path to a
   target margin (sector default or guidance), tax, reinvestment (sales-to-capital), WACC (CAPM + after-tax debt,
   target weights), terminal FCFF₍ₙ₊₁₎ / (WACC − g), EV − debt + cash − minorities → ÷ diluted shares. Every assumption
   shown with its source in Breakdown › DCF; sector defaults; stock overrides via the existing `fv_assumptions` ledger.
   Reverse DCF on the same model: which growth/margin the price implies vs our assumption → explains each gap.
4. **Hand tests:** PLTR (hyper-growth), MU (cyclical peak), CHTR (levered), KO (quality), JPM (bank → excess returns,
   not DCF), O (REIT → P/FFO/NAV). Compare with public analyst/Morningstar DCFs. Jamie's class method = reference.
5. **Blend:** DCF becomes the main vote where it applies; peer P/E only after growth adjustment; target per step 1.

---

# Fair value — next session (Jamie 10-27)

**Status 10-27 late:** steps 1–2 done (`gap_attribution.py`), step 3 shipped as **fv-1.2.0** (street anchor + vote floor;
FINDINGS §7). Next, in order: (a) growth software in pre-revenue cohorts gets no P/E vote (PLTR/DDOG/PANW −60 %) →
give profitable members the peer/warranted P/E; (b) cyclicals at peak EPS (MU/SNDK +150 %) → cap the multiple at the
group's own-history median or lean on the street; (c) LSEG FY2/LTG for the ~600 names without IBES FY2 (growth inputs);
(d) rebuild the 2020–26 panel (`bt_load.py`; workdir was temp, needs splits.json + FRED AAA/GS10) and confirm IC ≥ 0 for
the anchored blend; (e) ops below.


Goal: find the factors behind the biggest gaps between Fildi fair value (fv-1.1.0) and price by **reverse-engineering what the
price implies**, then adjust the model dynamically per sector / pattern group. Start here; don't re-run the audit.

## Where we are
- Table: `research/fair_value/out/fv_review.md` (`artifacts/api-server/src/scripts/fv-review.ts` regenerates it + JSON).
  89 names = watchlist + closest/farthest 2 in 9 thin sectors.
- Universe gap (791 valued): median +3 %, IQR −18…+29 %, normal (Tukey) −58…+155 %, 38 outliers, mean |gap| ex-outliers 31 %.
- Fixed 10-27: LSEG consensus for the whole universe (FY1 245 → 903 names); FY1 checked vs vendor forward P/E (GM in, BAP PEN out).
- Prior work: S111 (91 extreme gaps by cause; warranted-P/S prototype FAIL), `research/fair_value/FINDINGS.md`,
  memory: cheapness gaps don't predict returns; expectation changes (fwd growth, PT revisions) do.

## Gap patterns seen (hypotheses to test, not conclusions)
1. Growth on mature multiples, −70…−95 %: PLTR SHOP CAVA GH GKOS CRCL CHYM TSLA (+ HOOD AFRM). Peer P/E × FY1, growth cap 20 %,
   analyst target always trimmed as the high vote.
2. Low P/E, levered or event-driven, +80…+200 %: CHTR OMC AES PCG EG SMCI PBR VZ ECHO.
3. Quality / scarcity premium, ≈ −50 %: KO MNST WELL TPL IBKR AAPL.
4. Big Tech group has 5 names → valued on the technology-sector median P/E.

## Step 1 — reverse-engineer the price (market-implied expectations)
For every valued name, solve what the current price implies, with the inputs we already store:
- **Implied growth**: reverse DCF on FCF / earnings (the model already outputs `implied_growth` for standard modes) —
  solve g (and/or years of excess growth) that makes DCF = price; compare with consensus LTG / FY1→FY2 growth.
- **PVGO split**: price = EPS₁ / r + PVGO → share of the price that is future growth (r from CAPM, same as the model).
- **Implied cost of equity** (Ohlson-Juettner already a voter; Easton PEG as a check) vs the model's CAPM r.
- **Implied multiple vs fundamentals**: what P/E / EV/EBITDA the price implies vs the peer median we apply.
Output per name: implied g, PVGO %, implied r, and which input explains most of log(FV/price).

## Step 2 — attribute the gap (cross-section, all 791)
Regress log(FV / price) on: forward growth (FY1→FY2, LTG), ROE/ROIC, margins, net debt / EBITDA, beta / vol, revisions
(StarMine ARM, PT changes), size, cyclicality, ADR/currency flag, analyst-target gap, sector. Use a decomposition
(Shapley / LMG or GBM + SHAP) → top drivers overall and per sector. Smoke test on ~20 hand-checked names first.

## Step 3 — dynamic adjustment (per sector / pattern group)
Replace fixed peer-median multiples with a warranted multiple fitted daily per sector, e.g. P/E = f(growth, ROE, risk)
(Damodaran-style sector regressions), and let the analyst target stay in the blend when the gap is explained by growth.
Pre-register: walk-forward vs fv-1.1.0 on the FINDINGS backtest (error vs later price, IC of gap), stop rule, before/after
on the 89-name table. Scoring changes need Jamie's OK on the before/after (task request = approval to build).

## Ops follow-ups (small, do first)
- Universe removals: `research/lseg/universe_review.py` only adds. Add a rule to deactivate names that fall below the bar
  (e.g. cap < $5B or < $10M/day for 3 months, not held / watchlisted) and show what it would remove before applying.
- Check the 10-28 05:00 run: fit model should score ~906 (was 466) → LSEG coverage model tier grows → history backfills
  automatically; peer check step runs; FV recompute picks up new names.
