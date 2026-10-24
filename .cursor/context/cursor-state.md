# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code).

**Last updated:** 2026-10-24 (A211 stage 1 + A248 + Fri LSEG backfill path)

## Next build
1. A241 P0.5 gitleaks install/scan → then `cursor/gcp-shadow` branch when tree clean
2. A241 P1 blocked on Jamie GCP
3. Continue Fri `backfill_option_session.py` until model_recs coverage thick (optional)
4. Commit miss-day path (option_chain_history load + daily.py Fri snapshot + maintain wake) if not yet on remote

## Done this session
- A211 stage 1 → `.agents/context/job-host-split.md`
- A248 net-exit gate in `~/rbh_scripts/export_rbh_transactions.py`
- Fri miss reconstruct via LSEG (`backfill_option_session.py` + `--from-history`); partial Fri cohort restored
- A244 still Claude (S081 FAIL)

## Phase
Ops/privacy inventory ready for VM shadow. No Mac schedule cutover.
