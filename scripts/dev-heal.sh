#!/bin/bash
# Heal local stack without full restart when possible:
# adopt pidfiles to live listeners, kill stale/extra fildi listeners.
# Exit 0 = clean; 1 = needs ./scripts/dev-restart.sh (service down) or still dirty.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/local-stack.mjs" heal "$@"
