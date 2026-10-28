# A286 packet — segment XBRL → dcf_segments (S118)

**As of 2026-10-28**

| ticker | 10-K end | segment rev $B | filings total $B | cov |
|---|---|---:|---:|---:|
| AMZN | 2025-12-31 | 716.9 | 716.9 | 100.0% |
| GOOGL | 2025-12-31 | 403.0 | 402.8 | 100.0% |
| MSFT | 2026-06-30 | 331.8 | 331.8 | 100.0% |
| TSLA | 2025-12-31 | 94.8 | 94.8 | 100.0% |
| GEV | 2025-12-31 | 38.5 | 38.1 | 101.2% |

Parser: `dcf/segments.py` → `watchlist_sync.dcf_segments` + vendor_raw. `engine.inputs.segments` = mix when ≥2 members.
**Still open:** per-segment NOPAT path (SOTP valuation) — mix is ready; do not flip fv-2.0.0 until that ships.
