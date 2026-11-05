# S154 — Signal-state strategy playbook (walk-forward)

**Ask:** A336 · **Window:** 2026-10-08 → 2026-11-05 · **Chain days:** 19 · **Entries:** 1993 · **Pricing:** RH 23% spread; exit BS entry IV (flat); mirrors paired per spec.

## Verdict

**No state→structure rule passes** pre-registered bar (19 chain days; multi-day holds need more snapshots — MDE below).

## Walk-forward (train Sortino → OOS vs baselines)

| state | in-sample pick | in Sortino | OOS Sortino | vs 30Δ put | vs random | n OOS | days | Holm p | pass |
|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|
| post_signal_filtered | iron_condor close | 17.59 | 0.79 | -0.04 | 23.94 | 85 | 7 | 1 | N |
| post_signal_filtered_countertrend | short_outright_otm close | 8.48 | 1.14 | 0.08 | 4.27 | 47 | 8 | 1 | N |
| pre_quiet_12 | long_outright 30m | 13.66 | 335.52 | 2.41 | 18.49 | 128 | 10 | 1 | N |
| pre_quiet_24 | long_outright 30m | 13.34 | 337.32 | 2.40 | 17.71 | 126 | 10 | 1 | N |
| pre_quiet_6 | long_outright 30m | 13.44 | 335.88 | 2.28 | 15.89 | 128 | 10 | 1 | N |

## Losing OOS cells — mirrors (sample)

**post_signal_filtered** (iron_condor close):
- iron_condor -5.6% → mirror long_strangle +36.2%
- iron_condor -7.5% → mirror long_strangle -7.8%
- iron_condor -30.2% → mirror long_strangle +5.9%
**pre_quiet_12** (long_outright 30m):
- long_outright -7.4% → mirror short_outright_otm -57.8%
- long_outright -14.9% → mirror short_outright_otm +86.7%
**pre_quiet_24** (long_outright 30m):
- long_outright -7.4% → mirror short_outright_otm -57.8%
- long_outright -14.9% → mirror short_outright_otm +86.7%
**pre_quiet_6** (long_outright 30m):
- long_outright -7.4% → mirror short_outright_otm -57.8%
- long_outright -14.9% → mirror short_outright_otm +86.7%

## Quiet-state premium selling

Walk-forward Sortino **picked directional `long_outright` 30m** on all quiet N (not a premium sale). No quiet state passes OOS bar (n=126–128, Holm p=1 vs random). Premium structures (short_put_otm, iron_condor, credit_far) were in the grid; none outranked random Sortino on OOS for quiet states.

## Spot-checked trade

- AAOI quiet pre_signal bar · **short_put_otm** hold 30m · entry 117.93 → exit 118.40 (30m) · P&L +71.4% risk · random +nan% · 30Δ put baseline +96.3%

## MDE / data

- Calendar span **19** sessions with chain coverage; pass bar needs **≥100 OOS trades on ≥10 days** per state.
- Extend `option_chain_history` + intraday bars for multi-day DTE-matched exits (7–14 / 30–45 DTE buckets under-sampled here).

## Methods

- States: post-signal (S153 filters on 5m; UT trend-aligned vs countertrend) + pre-quiet (N=6/12/24, squeeze-off, one entry/ticker/day).
- Walk-forward: first/second calendar half; one pick per state; no re-tune after OOS.
- Baselines: vol-matched random (preMove ±0.25), always short 30Δ put; B&H/T-bill omitted (same sign as stock structures).

Re-run: `research/studies/scripts/s154_signal_state_playbook.py` · `research/studies/out/S154/playbook.json`
