#!/usr/bin/env bash
# On-demand research fetcher (A123): web page → clean markdown, local only. See research/crawl/fetch_page.py.
#   scripts/fetch-page.sh <url> [<url> ...] [--deep N] [--save] [--max-chars N]
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/research/crawl/.venv/bin/python"
[ -x "$PY" ] || { echo "fetch-page: missing venv — python3 -m venv research/crawl/.venv && research/crawl/.venv/bin/pip install crawl4ai && research/crawl/.venv/bin/python -m playwright install chromium" >&2; exit 3; }
exec "$PY" "$ROOT/research/crawl/fetch_page.py" "$@"
