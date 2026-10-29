# A314 family 5 — cross-asset leads

No cross-asset 5m in optlab; intraday = prior-close→open shock, SPY/QQQ ~120m checkpoint, placebo same minute on calm days. Daily = Yahoo 1d (vendor_raw).

- **hyg_ie_shock** · Credit stress (HYG/IEF) · overnight HYG/IEF selloff → ↑ SPY drop ≥½ ATR · n=12 · effect +nan/+nanpp · t +nan/+nan · inc -12.7/-20.5 · MDE≈12.1pp · **FAIL**
- **tlt_flight** · Flight to quality (TLT) · overnight TLT rally + SPY not up → ↑ drop risk · n=46 · effect +0.0/+8.7pp · t +0.0/+0.5 · inc -0.2/+0.5 · MDE≈5.3pp · **FAIL**
- **uup_spike** · DXY / UUP · overnight UUP spike → ↑ SPY drop risk · n=74 · effect +18.1/-8.2pp · t +1.7/-1.1 · inc +1.5/-1.4 · MDE≈3.3pp · **FAIL**
- **usdjpy_yen** · USD/JPY · overnight USDJPY drop (yen up) → ↑ drop risk · n=160 · effect -12.0/-3.9pp · t -2.1/-0.6 · inc -1.9/-0.1 · MDE≈1.3pp · **FAIL**
- **btc_riskoff** · BTC risk-off · overnight BTC −2% → ↑ SPY drop risk · n=54 · effect +0.0/+4.4pp · t +0.0/+0.4 · inc -0.5/+0.3 · MDE≈4.0pp · **FAIL**
- **hyg_ie_day** · Credit (HYG/IEF) · HYG/IEF 1d ≤ −1% → ↑ 5–10d put breach · n≈57 · breach Δ -4.7/+0.3pp · t -0.9/+0.1 · inc n/a · MDE≈1.8pp · **FAIL daily**
- **tlt_spike_day** · Rates (TLT) · TLT 1d ≥ +1% → ↑ breach · n≈95 · breach Δ +6.4/-0.5pp · t +0.8/-0.1 · inc n/a · MDE≈2.0pp · **FAIL daily**
- **uup_spike_day** · DXY (UUP) · UUP 1d ≥ +0.5% → ↑ breach · n≈89 · breach Δ +3.9/+4.7pp · t +0.5/+1.2 · inc n/a · MDE≈0.2pp · **FAIL daily**
- **usdjpy_day** · USD/JPY · USDJPY 1d ≤ −0.5% (yen up) → ↑ breach · n≈173 · breach Δ +10.5/-0.8pp · t +2.6/-0.3 · inc n/a · MDE≈2.4pp · **FAIL daily**
- **btc_crash_day** · BTC · BTC 1d ≤ −3% → ↑ breach · n≈68 · breach Δ +nan/+6.2pp · t +nan/+1.5 · inc n/a · MDE≈7.2pp · **FAIL daily**
- put overlay: none (no PASS with incremental |t|≥2)
