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
