---
name: signal-filters
description: RSI thresholds, MFI gate, Recent Move filter, Option Income Gate. Source of truth for all 31 tickers.
---
## RSI Thresholds
```typescript
export const RSI_THRESHOLDS: Record<string,number> = {
  // Tier 1 (>=92% win rate): favorites, happy to be assigned
  NVDA:45,INTC:45,MRVL:44,PLTR:42,HOOD:43,RDDT:42,AAPL:38,AMZN:40,GOOGL:40,TSLA:42,NOW:42,
  // Tier 2 (>=94% win rate): less conviction
  BABA:38,SMCI:40,SNOW:40,AAOI:42,NFLX:38,NET:40,OPEN:35,ONDS:35,POET:35,SHOP:40,FSLY:35,RUM:35,
  // Tier 3 (>=97% win rate): risky/futuristic, high income
  JOBY:32,ACHR:32,BB:34,IONQ:32,SOFI:34,TTD:36,RKLB:32,RDW:32,
};
export const MFI_THRESHOLD = 25; // same all tickers

export const TIER_CONFIG = {
  1: { rmFilter:0.03,  minOTM:0.05, maxOTM:0.10, minIncome:0.008 },
  2: { rmFilter:-0.02, minOTM:0.10, maxOTM:0.15, minIncome:0.010 },
  3: { rmFilter:-0.02, minOTM:0.15, maxOTM:0.20, minIncome:0.012 },
};
```
## Recent Move filter
  return5d <= tier.rmFilter  → PROCEED
  return5d <= 0.08           → CHECK_CATALYST (gray zone)
  return5d >  0.08           → EXCLUDE

## Valid catalyst overrides
  YES: index_inclusion, ai_product_launch, earnings_beat+guidance_raise, fda_approval
  NO:  sector_sympathy, meme_pump, social_media, no_identifiable_catalyst

## Macro gates
  VIX > 25 → skip | VIX > 20 → half size | earnings within 14d → half/skip

## Special notes
  NVDA: 100% recovery — most aggressive T1 entry ok
  PLTR: 60% recovery — C1 entry only, no stretch
  RDDT: 100% recovery within 2 weeks
  HOOD: never sell after rip, wait for full mean reversion
  OPEN: Russell 3000 inclusion catalyst June 22-26 2026
