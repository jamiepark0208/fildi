#!/bin/bash
# Stop canonical + orphan listeners on API/Vite ports; clear pidfiles.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/local-stack.mjs" down "$@"
