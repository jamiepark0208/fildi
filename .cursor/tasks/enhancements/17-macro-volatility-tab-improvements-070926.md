# macro-volatility-tab-improvements

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Related** | [macro-regime-tab](10-macro-regime-tab-improvements-070926.md), [social-sentiment-polish](../new_app_features/9-social-sentiment-polish-070926.md) |

### Resolution (2026-07-13)
Shipped a Volatility Regime Read implication card synthesizing VIX level, term structure, VVIX, put/call, HY credit cross-check, and a newly added MOVE index into one overall verdict. Discovered along the way that the sentiment page's `ExtremesTable` was already redundant with `CotSection`'s inline extremes table, so `/sentiment` now redirects to `/macro?tab=volatility` instead of duplicating COT UI. A dead put/call data source was fixed by reusing the CNN fear-greed response as the feed. Follow-up compaction pass: 6 charts compacted into a 2x3 grid, VIX/Skew/VXN banner collapsed to a single-line VolStrip, and the COT section turned into a marquee-scrolling selector.
