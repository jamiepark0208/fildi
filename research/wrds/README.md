# WRDS research extracts (USC student)

**Academic / non-commercial only.** See **[PLAYBOOK.md](./PLAYBOOK.md)** for license, budget, allowlist, and value ranking.

Do **not** cron into live TradeDash scoring, FIELD_DEFS, or public APIs.

## Setup

```bash
cd research/wrds
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# WRDS_USERNAME / WRDS_PASSWORD + DATABASE_URL in repo-root .env.local
```

## Optimized workflows (preferred)

```bash
# Monthly IBES revisions/surprises → Postgres wrds_research.* (TTL 28d, watermarked)
# All syncs, one connection = one Duo approval (10-29): python run_batch.py [gics ibes crsp ...]; --list
# A rejected login is never retried (lockout); status → ~/.fildi/wrds-status.json → agent_start 11b
python sync_ibes.py --universe book

# Quarterly CRSP returns → wrds_research.crsp_dsf (TTL 90d; data lags ~2024-12)
python sync_crsp.py --universe book

# Re-run early
python sync_ibes.py --force --tickers NVDA,MSFT,AAPL
```

Re-reads use local DB — scripts skip WRDS when TTL has not expired.

## Legacy / debug pulls (parquet only)

```bash
python inventory.py                         # after subscription changes
python pull_ibes_revisions.py --tickers …   # ad-hoc parquet under out/
python pull_crsp_returns.py --tickers …
```

## Auth

`_auth.py` loads `WRDS_*` from repo-root `.env.local`. Never commit secrets.
