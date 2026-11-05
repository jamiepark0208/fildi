#!/usr/bin/env bash
# S153 launcher — resolves @workspace deps via api-server node_modules
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env.local"
set +a
cd "$ROOT/artifacts/api-server"
exec nice -n 15 pnpm exec node --import tsx "$ROOT/research/studies/scripts/s153_swing_reverse_engineer.mts" "$@"
