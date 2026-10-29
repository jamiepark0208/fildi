# A314 family 4 — TV regime/trend tools
SPY+QQQ 480d · H1<2025-11-11≤H2 · day-mean event−placebo gap · incr=logit(dropx~S126+event) · **no ship**

- **squeeze_release** · LazyBear Squeeze Momentum · squeeze release + mom>0 → lower drop (trend burst) · n=839 · eff -0.4/+0.3 · t -0.3/+0.4 · incr -2.6/-0.6 · MDE 3.2/2.2pp · **FAIL**
- **squeeze_release_dn** · LazyBear Squeeze Momentum · squeeze release + mom<0 → higher drop · n=781 · eff -0.0/-0.2 · t -0.0/-0.1 · incr -0.6/+0.0 · MDE 3.1/3.1pp · **FAIL**
- **wt_os_cross** · LazyBear WaveTrend · WaveTrend OS cross up → lower drop (reversal up) · n=558 · eff +1.7/+1.0 · t +1.7/+1.2 · incr -1.2/+3.1 · MDE 2.8/2.3pp · **FAIL**
- **wt_ob_cross** · LazyBear WaveTrend · WaveTrend OB cross down → higher drop · n=688 · eff +1.0/+0.2 · t +1.2/+0.1 · incr -1.8/-1.0 · MDE 2.3/5.0pp · **FAIL**
- **hurst_trend** · rolling R/S Hurst · Hurst>0.55 → higher rest range (persistent trend) · n=13883 · eff -4.0/-2.0 · t -2.7/-1.5 · incr -0.1/+0.5 · MDE 4.2/3.7pp · **FAIL**
- **hurst_chop** · rolling R/S Hurst · Hurst<0.45 → higher drop (mean-revert chop) · n=3596 · eff +1.8/+1.0 · t +1.5/+0.7 · incr +1.2/+0.1 · MDE 3.3/3.9pp · **FAIL**
- **fdi_chop** · Ehlers FDI · FDI>1.5 chop → higher rest range · n=12119 · eff +3.6/+5.0 · t +2.3/+5.0 · incr +1.5/+1.5 · MDE 4.3/2.7pp · **FAIL (incr over S126)**
- **fdi_trend** · Ehlers FDI · FDI<1.3 trend → lower drop · n=19691 · eff +1.8/+1.2 · t +1.2/+1.5 · incr -3.2/-2.1 · MDE 4.3/2.1pp · **FAIL**
- **mesa_it_fall** · Ehlers IT proxy (EMA12) · EMA12 slope −0.15%/3bar → higher drop (5m; Pine IT on daily S130) · n=2407 · eff -5.4/-2.8 · t -3.1/-2.0 · incr +2.2/+5.9 · MDE 4.9/3.9pp · **FAIL** · **Live incr**
- **chop_high** · Choppiness Index · CHOP>61.8 → higher rest range (chop) · n=7181 · eff +0.0/-0.0 · t +0.1/-0.1 · incr -1.4/-0.1 · MDE 0.9/1.0pp · **FAIL**
- **chop_zone_trend** · Chop Zone / CHOP · CHOP<38.2 trend zone → lower drop · n=8879 · eff +0.0/+1.1 · t +0.0/+1.2 · incr +3.0/+4.0 · MDE 2.8/2.6pp · **FAIL** · **Live incr**
- **mesa_it_fall drop odds** (% with/without by S126): H1 calm 10.1/10.1, normal 29.3/14.8, elevated 27.5/14.6, stormy 43.6/34.5; H2 calm 15.5/4.3, normal 31.4/7.9, elevated 34.0/16.7, stormy 45.7/20.0
- **chop_zone_trend drop odds** (% with/without by S126): H1 calm 11.0/10.0, normal 19.4/14.5, elevated 24.8/13.2, stormy 38.1/35.0; H2 calm 6.3/4.1, normal 14.4/7.4, elevated 20.5/16.7, stormy 34.5/19.7
- **daily S130** · squeeze_rel +0.3/-2.7; wt_ob -0.9/+1.2; hurst_tr -1.0/-0.5; fdi_ch +0.5/-0.6; chop_hi -0.2/+0.3; mesa_it_fall sparse · breach t · **FAIL daily** (no |t|≥2 both halves)

## Put benchmark
- `chop_zone_trend` skip prior SPY `chop_zone_trend`: Δ-10.1bp t-4.1 → **WORSE**
- `mesa_it_fall` skip prior SPY `mesa_it_fall`: Δ-3.3bp t-2.1 → **WORSE**
