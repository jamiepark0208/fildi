# Shared research contracts (WRDS + LSEG)

See `research/LSEG_WRDS_SYNC.md`.

| File | Role |
|---|---|
| `universe_book.txt` | Single ticker book (≤50) — both lanes |
| `universe.py` | `book` / `registry` / `holdings` / `coverage` + `--earnings-watch` |
| `schema_security_map.sql` | `research_common.security_map` |
| `health.py` | Loop F — both `sync_state` + LSEG `:9000` TCP (no vendor calls) |
| `out/*.json` | Cross-lane handoffs (earnings_watch, reconcile, calibrate, CAR) — gitignored |

Edit the book here only. Lanes import; they do not keep a private copy.

**Ops:** `python health.py` or Settings → Scheduled Tasks → Research Ops Health. App scores never require live WRDS/LSEG — see `LSEG_WRDS_SYNC.md` §13.
