# S154 — Signal-state strategy playbook (walk-forward)

**Ask:** A336 · **Window:** 2026-10-08 → 2026-11-05 · **Chain days:** 19 · **Entries:** 1993 · **Pricing:** shared `option_pricing.py` (RH 23% spread; BS exit @ entry IV). **Holds:** 30m, 60m, close. lseg daily iv30_put: 1/59 study names ≥1y (2025-10-08→2026-10-08) — multi-day/swing holds skipped.

## Verdict

**Post-signal states: no pass** (OOS n&lt;100 and/or Sortino below vol-matched random; Holm p≈1). **Quiet states (N=6/12/24): 3/3 pass** pre-registered bar with in-sample pick **long_strangle 30m** (Sortino ~0.3 vs random ~−0.85, n≈220, Holm p≪0.05) — debit vol, not premium-selling. Multi-day/swing skipped (daily IV coverage).

## Walk-forward (train Sortino → OOS vs baselines)

| state | in-sample pick | in Sortino | OOS Sortino | vs 30Δ put | vs random | n OOS | days | Holm p | pass |
|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|
| post_signal_filtered | iron_condor close | 2.89 | 0.74 | -0.14 | 5.92 | 85 | 7 | 0.905 | N |
| post_signal_filtered_countertrend | short_outright_otm close | 2.81 | 15.77 | 0.17 | 2.47 | 47 | 8 | 0.278 | N |
| pre_quiet_12 | long_strangle 30m | 4.19 | 0.28 | 0.26 | -0.85 | 222 | 10 | 0 | Y |
| pre_quiet_24 | long_strangle 30m | 4.05 | 0.42 | 0.17 | -0.84 | 221 | 10 | 7.48e-12 | Y |
| pre_quiet_6 | long_strangle 30m | 4.24 | 0.28 | 0.26 | -0.84 | 223 | 10 | 2.53e-09 | Y |

## Losing OOS cells — mirrors (sample)

**post_signal_filtered** (iron_condor close):
- iron_condor -6.5% → mirror long_strangle +17.2%
- iron_condor -8.6% → mirror long_strangle -9.7%
- iron_condor -24.9% → mirror long_strangle +8.4%
**pre_quiet_12** (long_strangle 30m):
- long_strangle -4.2% → mirror iron_condor +1.3%
- long_strangle -4.6% → mirror iron_condor +3.4%
**pre_quiet_24** (long_strangle 30m):
- long_strangle -4.2% → mirror iron_condor +1.3%
- long_strangle -4.6% → mirror iron_condor +3.4%
**pre_quiet_6** (long_strangle 30m):
- long_strangle -4.2% → mirror iron_condor +1.3%
- long_strangle -4.6% → mirror iron_condor +3.4%

## Quiet-state premium selling

- **pre_quiet_12:** pick `long_strangle` 30m · OOS Sortino 0.28 (30Δ put 0.26, random -0.85) n=222
- **pre_quiet_24:** pick `long_strangle` 30m · OOS Sortino 0.42 (30Δ put 0.17, random -0.84) n=221
- **pre_quiet_6:** pick `long_strangle` 30m · OOS Sortino 0.28 (30Δ put 0.26, random -0.84) n=223

## Passing rule — OOS trade stats (long_strangle 30m, % of premium, no re-tune)

| quiet N | n OOS | avg | median | win% | CVaR 5% | max DD |
|---:|---:|---:|---:|---:|---:|---:|
| 6 | 223 | +2.28 | −3.76 | 13.0 | −23.5 | −420 |
| 12 | 222 | +2.26 | −3.78 | 12.6 | −23.5 | −426 |
| 24 | 221 | +3.12 | −3.56 | 14.0 | −21.6 | −237 |

Time-of-day OOS: first hour 0 entries; midday ~100%; last hour 0–2 (N=24). Per-ticker: `research/studies/out/A336_A334/packet_supplement.json`.

## Spot-checked trade

- AAOI quiet pre_signal bar · **short_put_otm** hold 30m · entry 117.93 → exit 118.40 (30m) · P&L +0.1% risk · random +nan% · 30Δ put baseline +0.2%

## MDE / data

- Calendar span **19** entry session halves; pass bar needs **≥100 OOS trades on ≥10 days** per state.
- lseg daily iv30_put: 1/59 study names ≥1y (2025-10-08→2026-10-08) — multi-day/swing holds skipped.
- Sanity: `test_option_pricing.py` (parity, random straddle <0, short 15Δ put on +0.4% spot <20% risk).

## Methods

- States: post-signal (S153 filters on 5m) + per-indicator post + pre-quiet (N=6/12/24, squeeze-off, no 6-ind signal).
- Walk-forward: first/second calendar half; one pick per state; no re-tune after OOS.
- Baselines: vol-matched random (preMove ±0.25), always short 30Δ put; B&H/T-bill omitted (same sign as stock structures).

Re-run: `research/studies/scripts/s154_signal_state_playbook.py` · `research/studies/out/S154/playbook.json`

## multi-day 11-04

**Holds:** 1d, 3d, 5d, swing (opposite 1h flip, cap 10d). **DTE:** 10d (1/3/5d), 35d (swing). **Pricing:** daily `iv30_put` synthetic chain via `option_pricing.make_iv_snap`. **Excluded (IV&lt;252d):** ALOY, DRAM, HOOY, IOND, OKLO, RDDT, RUM, SECZ, SKHY, SPCX, USAR. lseg daily iv30_put: 49/49 non-thin names ≥252d (2024-11-04→2026-11-05) — multi-day/swing enabled.

**No cell passes** the pre-registered bar on multi-day holds.

| state | pick | n | avg | median | win% | CVaR5 | max DD | ex-top avg | tickers+ | OOS Sortino | vs put | vs rnd | Holm p | pass |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| post_signal_filtered | short_call_otm 1d | 64 | +2.43 | +1.62 | 95.3 | -0.0 | -0.0 | +2.25 | 100% | 467.57 | 0.07 | inf | 1 | N |
| post_signal_filtered_countertrend | short_straddle 1d | 52 | +18.46 | +20.79 | 88.5 | -74.6 | -149.2 | +15.28 | 92% | 1.24 | 0.25 | 9.56 | 0.914 | N |
| pre_quiet_12 | short_call_otm 1d | 118 | +2.66 | +1.80 | 91.5 | -6.1 | -14.5 | +2.59 | 95% | 1.50 | 0.08 | inf | 1 | N |
| pre_quiet_24 | short_call_otm 1d | 116 | +2.61 | +1.80 | 91.4 | -6.1 | -14.5 | +2.54 | 95% | 1.46 | 0.09 | inf | 1 | N |
| pre_quiet_6 | short_call_otm 1d | 118 | +2.67 | +1.80 | 91.5 | -6.1 | -14.5 | +2.60 | 95% | 1.50 | 0.09 | inf | 1 | N |
