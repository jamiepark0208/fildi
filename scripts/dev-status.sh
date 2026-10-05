#!/bin/bash
# Show API/Vite up|down, age, and port orphans (detached Mac stack).
# Exit 0 = clean (both up, no orphans); 1 = down or drift.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/local-stack.mjs" status "$@"
