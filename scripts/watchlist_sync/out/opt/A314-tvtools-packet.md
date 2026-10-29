# A314 family 4 — TV regime/trend tools
SPY+QQQ 480d · H1<2025-11-11≤H2 · minute placebo · incr=logit(dropx~S126+event) · **no ship**

- **squeeze_release** · [LazyBear Squeeze](https://www.tradingview.com/script/nqQ1DT5a-Squeeze-Momentum-Indicator-LazyBear/) · release+mom>0 → lower drop · n=839 · eff +0.0/+0.3pp · t +0.1/+0.8 · incr −2.6/−0.6 · MDE≈1.8pp · **FAIL**
- **squeeze_release_dn** · LazyBear Squeeze · release+mom<0 → higher drop · n=781 · eff −1.2/−1.6pp · t −0.8/−0.3 · incr −0.6/+0.0 · MDE≈2.5pp · **FAIL**
- **wt_os_cross** · [LazyBear WaveTrend](https://www.tradingview.com/script/2KE8wTuF-Indicator-WaveTrend-Oscillator-LazyBear/) · OS cross up → lower drop · n=558 · eff +0.4/+2.1pp · t +0.7/+1.4 · incr −1.2/+3.1 · MDE≈1.9pp · **FAIL**
- **wt_ob_cross** · LazyBear WaveTrend · OB cross down → higher drop · n=688 · eff +0.0/−1.2pp · t +0.6/−1.7 · incr −1.8/−1.0 · MDE≈2.2pp · **FAIL**
- **hurst_trend** · rolling R/S Hurst · H>0.55 → higher rest range · n=13883 · eff −6.3/+0.9pp · t −2.7/−1.6 · incr −0.1/+0.5 · MDE≈2.8pp · **FAIL**
- **hurst_chop** · Hurst · H<0.45 → higher drop · n=3596 · eff −2.9/−0.1pp · t +1.8/+0.7 · incr +1.2/+0.1 · MDE≈2.4pp · **FAIL**
- **fdi_chop** · [Ehlers FDI](https://www.tradingview.com/script/UlJKijY2-Ehlers-Fractal-Dimension-Index/) · FDI>1.5 → higher rest range · n=12119 · eff +12.2/+9.6pp · t +2.4/+5.0 · incr +1.5/+1.5 · MDE≈2.4pp · **FAIL (incr over S126)**
- **fdi_trend** · Ehlers FDI · FDI<1.3 → lower drop · n=19691 · eff −3.9/−1.7pp · t +1.6/+0.7 · incr −3.2/−2.1 · MDE≈2.4pp · **FAIL**
- **mesa_it_fall** · [Ehlers IT](https://www.tradingview.com/script/WigIA933-Ehlers-Instantaneous-Trendline/) · EMA12 slope −0.15%/3bar (5m IT degenerate) → higher drop · n=2407 · eff +0.5/+2.8pp · t −3.0/−2.1 · incr +2.2/+5.9 · MDE≈3.1pp · **FAIL (t vs effect sign)**
- **chop_high** · [CHOP](https://www.tradingview.com/script/TAhtEVER-Choppiness-Index/) · CHOP>61.8 → higher rest range · n=7181 · eff −4.0/−0.4pp · t +0.0/−0.1 · incr −1.4/−0.1 · MDE≈0.7pp · **FAIL**
- **chop_zone_trend** · Chop Zone / CHOP<38.2 → lower drop · n=8879 · eff +0.7/+2.0pp · t +0.1/+1.2 · incr +3.0/+4.0 · MDE≈1.9pp · **FAIL** (wrong sign vs claim)
- **daily S130** · squeeze/wt/hurst/fdi/chop breach · t +0.3/−2.7; −0.9/+1.2; −1.0/−0.5; +0.5/−0.6; −0.2/+0.3 · **FAIL daily**
- put overlay: mesa harness-only candidate skip → Δ−3.3bp t−2.1 **WORSE** (not run for ship)
