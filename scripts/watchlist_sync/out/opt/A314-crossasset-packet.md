# A314 family 5 — cross-asset leads

No cross-asset 5m in optlab; intraday = prior-close→open shock, SPY/QQQ ~120m checkpoint, placebo same minute on calm days. Daily = Yahoo 1d (vendor_raw).

- **hyg_ie_shock** · Credit stress (HYG/IEF) · n 6/6 · effect -20.5/-17.7pp · t -5.6/-7.0 · inc -11.5/-35.3 · MDE 10/7pp · **FAIL**
- **tlt_flight** · Flight to quality (TLT) · n 22/24 · effect +10.8/-2.1pp · t +0.7/-0.2 · inc n/a/-0.4 · MDE 41/32pp · **FAIL**
- **uup_spike** · DXY / UUP · n 36/38 · effect +19.6/-5.2pp · t +1.7/-0.7 · inc +1.4/-0.8 · MDE 33/22pp · **FAIL**
- **usdjpy_yen** · USD/JPY · n 80/80 · effect -13.4/-4.9pp · t -1.9/-0.9 · inc -1.6/-0.8 · MDE 20/15pp · **FAIL** · opp (fewer drops)
- **btc_riskoff** · BTC risk-off · n 26/28 · effect +4.0/+0.4pp · t +0.4/+0.0 · inc -0.2/-0.2 · MDE 32/29pp · **FAIL**
- **hyg_ie_day** · Credit (HYG/IEF) · n 28/29 · breach Δ -2.5/-0.7pp · t -0.5/-0.1 · inc -0.6/-0.3 vs ATR80+ER40 · MDE 14/14pp · **FAIL daily**
- **tlt_spike_day** · Rates (TLT) · n 47/48 · breach Δ +1.4/+0.9pp · t +0.3/+0.2 · inc +0.2/+0.2 vs ATR80+ER40 · MDE 13/12pp · **FAIL daily**
- **uup_spike_day** · DXY (UUP) · n 44/45 · breach Δ +4.3/+4.0pp · t +0.8/+0.8 · inc +0.7/+0.9 vs ATR80+ER40 · MDE 15/14pp · **FAIL daily**
- **usdjpy_day** · USD/JPY · n 86/87 · breach Δ +10.8/+0.7pp · t +2.4/+0.2 · inc +2.8/+0.1 vs ATR80+ER40 · MDE 12/9pp · **FAIL daily**
- **btc_crash_day** · BTC · n 34/34 · breach Δ +2.7/+8.7pp · t +0.5/+1.4 · inc +0.5/+1.6 vs ATR80+ER40 · MDE 16/18pp · **FAIL daily**
- put overlay: none (no PASS with incremental |t|≥2)
