# S205 — Panic day (11-20 type): long calls vs call spread vs short put vs stock
**Question (Jamie 11-23):** after the 11-20 NVDA CEO-exit crash (NVDA −42 % off high, −14 % on the day; SPY −10 % off high; VIX 35.9, VIX÷VIX3M 1.16) and the 11-23 bounce (SPY +4.7 %, NVDA +31 %), was buying calls on Friday the better move than selling puts?
**Event:** VIX ≥ 30 AND VIX÷VIX3M ≥ 1 AND close ≥ 7 % below 20 d high; declustered 10 td. SPY/QQQ 2008→2026 (VIX3M starts 12-2007). Panel `~/.fildi/cache/fast_screen_bars_2003.pkl`; VIX/VIX3M = FRED VIXCLS/VXVCLS.
**Pricing (labelled):** BS, IV = 0.9×VIX ATM (QQQ ×1.04), 5 % OTM put +4 vol, +5 % call −2 vol; exit IV = VIX on exit day. No spread cost. Scripts `research/studies/s205/`.
**Pre-registered signs:** calls + at h20 below 200 d (mean reversion) with a fat left tail; short put higher win rate, lower $ per event.

## Results (SPY, n = 34; 30 below 200 d, 4 above → above-200 cell can't answer at this n)
| h | stock | ATM call (% premium) | ATM/+5 % call spread (% debit) | 5 % OTM short put (% cash) | put on 20 % margin |
|---|---|---|---|---|---|
| 1 d | +0.7 % | +4.3 % (med −5 %, win 44 %) | +5.6 % | +0.4 % (win 65 %) | +1.9 % |
| 5 d | +1.8 % | +11.9 % (med +10 %) | +21.1 % | +1.1 % (win 85 %) | +5.5 % |
| 20 d | +1.6 % | +11.5 % (med −17 %, win 47 %) | +27.0 % (win 53 %) | +1.2 % (win 85 %) | +5.9 % |
QQQ n = 32 same shape: 20 d call +17 % mean / −42 % median; spread +29 %; put +2.0 % cash, 88 % win. Looser def (VIX ≥ 25, dd 5 %, n 51–52): same order.
Losers = first legs of real bear markets (2008-09/10, 2009-02, 2010-05, 2020-02, 2022-01/04): calls −100 %, short put −7…−18 % of cash.

**This event (model, Fri close → Mon close, VIX 35.9 → 26.6):** SPY ATM 30 DTE call ≈ +50–60 %; call spread ≈ +55 %; 5 % OTM short put ≈ +1.6–1.9 % of cash = 75–87 % of its max in one day. Real chain rows for ATM strikes were not stored (option_chain_history keeps OTM calls only).

## Panic-day entry vs waiting for the S172 un-invert (n = 17 per index — UNDERPOWERED, and only episodes that un-inverted within 40 td, which drops the 2008 legs → favours panic-day)
Median wait 3 td; index already +3.4 % above the panic close at the un-invert. SPY call 20 d: panic-day +32 % (med +28 %) vs un-invert +10 % (med −13 %); short put +2.1 % (17/17) vs +1.0 %. Direction: S172 timing gives back the first bounce. Needs a real-quote test before any rule change.

## Verdict
- Calls on the panic day: positive mean, **coin-flip median**, total-loss tail in true bear legs. Right in hindsight on 11-20, not a repeatable edge as a naked call.
- Best $ per risk = **ATM/+5 % call spread** (+27 % mean, keeps upside, caps the IV you pay). Best consistency = **5 % OTM index short put** (85 % win). Both beat stock per $ at risk.
- Short puts were not the wrong instrument on 11-20 — a Friday-sold 5 % OTM SPY put banked ~80 % of max by Monday.
- No pre-registered claim on single names (NVDA): the reversal came from news (CEO return). S177: long calls after single-name crashes −9 % on average.
