#!/usr/bin/env bash
# A241 P2 — Mac-side public-only dump. Never dumps PRIVATE/LICENSED tables.
# Usage: bash deploy/gcp/dump-public.sh
# Output: /tmp/fildi-public-dump/ (custom format + sanitized CSVs). Mac DB untouched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIST="$ROOT/deploy/gcp/public-tables.txt"
OUT="${OUT:-/tmp/fildi-public-dump}"
DBURL="${DATABASE_URL:-postgresql://jamiepark@127.0.0.1:5432/tradedash}"
mkdir -p "$OUT"
rm -f "$OUT"/*.dump "$OUT"/*.csv "$OUT"/manifest.txt "$OUT"/missing.txt

# Refuse if dump would include private name patterns
PRIVATE_RE='^(portfolio_|positions$|user_portfolio|trade_posts|stock_holdings|invite_codes|pm_book|pm_alerts|forecast_ledger|rh_raw|openjev_|lseg_|wrds_|optlab|lab_)'
while IFS= read -r t; do
  [[ -z "$t" || "$t" =~ ^# ]] && continue
  if [[ "$t" =~ $PRIVATE_RE ]]; then
    echo "FATAL: refuse private-looking name on allowlist: $t" >&2
    exit 1
  fi
done < "$LIST"

# Which PUBLIC tables exist on Mac
EXIST=()
MISSING=()
while IFS= read -r t; do
  [[ -z "$t" || "$t" =~ ^# ]] && continue
  if psql "$DBURL" -Atc "SELECT to_regclass('public.${t}') IS NOT NULL" | grep -qx t; then
    EXIST+=("$t")
  else
    MISSING+=("$t")
    echo "$t" >> "$OUT/missing.txt"
  fi
done < "$LIST"

echo "dumping ${#EXIST[@]} tables; ${#MISSING[@]} missing (ok)" | tee "$OUT/manifest.txt"
ARGS=()
for t in "${EXIST[@]}"; do
  ARGS+=(-t "public.${t}")
  echo "  + $t" | tee -a "$OUT/manifest.txt"
done

# Read-only session for dump
pg_dump "$DBURL" -Fc --no-owner --no-acl "${ARGS[@]}" \
  -f "$OUT/public.dump"

# SANITIZED: watchlist / stock_buckets / stub users (no secrets)
psql "$DBURL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
\copy (SELECT user_id, ticker, tier, color_tag FROM watchlist) TO '/tmp/fildi-public-dump/watchlist_sanitized.csv' CSV HEADER
SQL
# stock_buckets shape varies — best-effort
psql "$DBURL" -v ON_ERROR_STOP=0 -c "\copy (SELECT id, name, tickers FROM stock_buckets) TO '/tmp/fildi-public-dump/stock_buckets_sanitized.csv' CSV HEADER" \
  2>>"$OUT/manifest.txt" || echo "stock_buckets skip" >> "$OUT/manifest.txt"

# One stub user row (id only for FKs) — no real email/hash
psql "$DBURL" -Atc "SELECT id FROM users ORDER BY id LIMIT 1" > "$OUT/stub_user_id.txt" || true

# Safety: dump TOC must not mention private tables
if pg_restore -l "$OUT/public.dump" | grep -Ei 'portfolio_|positions|invite_codes|pm_book|lseg_|wrds_|optlab|lab_' ; then
  echo "FATAL: private name leaked into dump TOC" >&2
  exit 1
fi

ls -lh "$OUT" | tee -a "$OUT/manifest.txt"
echo "OK: $OUT/public.dump ready for scp → VM"
