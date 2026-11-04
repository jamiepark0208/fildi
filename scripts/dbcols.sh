#!/usr/bin/env bash
# One-line-per-table column lookup — run BEFORE writing SQL (11-03 audit: ~4 failed column/relation guesses per session,
# mostly date/ticker/created_at/as_of and missing schema prefixes).
# Usage: scripts/dbcols.sh <table-name-pattern> [column-pattern]
#   scripts/dbcols.sh macro_daily        → schema.table: col1 type, col2 type …
#   scripts/dbcols.sh % earnings_date    → every table that has a column matching earnings_date
set -euo pipefail
cd "$(dirname "$0")/.."
URL=$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2-)
T="${1:?table pattern}"; C="${2:-%}"
psql "$URL" -X -A -t -F' ' -c "
  SELECT table_schema||'.'||table_name||': '||string_agg(column_name||' '||
         replace(replace(data_type,'timestamp with time zone','tstz'),'character varying','varchar'), ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
  WHERE table_schema NOT IN ('pg_catalog','information_schema')
    AND table_name ILIKE '%${T}%'
    AND table_name IN (SELECT table_name FROM information_schema.columns WHERE column_name ILIKE '%${C}%')
  GROUP BY table_schema, table_name ORDER BY 1 LIMIT 15;"
