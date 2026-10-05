#!/bin/bash
# Install a macOS LaunchAgent that runs lean maintenance DAILY (7:00 local).
# Does NOT keep a Node process alive — launchd starts it, it exits.
#
# Why 7:00: open the Mac ~8 AM with API/Vite healed, lean enrich done, retention
# pruned, and morning precompute (event bullets / earnings / FMP) kicked off.
#
# Laptop sleep: StartCalendarInterval jobs missed while asleep run once on wake.
# Laptop powered OFF at the scheduled time: Apple does NOT catch up — wait for
# the next day the Mac is on. --enrich-if-due still catches up if enrichment_runs
# last success is ≥4 days old (DB-based, not clock-based).
#
#   ./scripts/install-maintenance-launchd.sh
#   ./scripts/install-maintenance-launchd.sh --uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.fildi.maintain"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
# Prefer Apple Silicon Homebrew node — /usr/local/bin/node is often Intel Rosetta
# and breaks Vite native deps (rollup/oxide/lightningcss) with exit 126 / wrong arch.
NODE=""
for candidate in /opt/homebrew/bin/node "$HOME/.local/bin/node" /usr/local/bin/node; do
  if [[ -x "$candidate" ]]; then
    NODE="$candidate"
    break
  fi
done
if [[ -z "$NODE" ]]; then
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" ]]; then
  echo "ERROR: node not found (need /opt/homebrew/bin/node on Apple Silicon)" >&2
  exit 1
fi
echo "Using node: $NODE ($(file -b "$NODE" 2>/dev/null || true))"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed ${LABEL}"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" /tmp/fildi-logs

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${ROOT}/scripts/maintain.mjs</string>
    <string>--enrich-if-due</string>
    <string>--drain-nr=40</string>
    <string>--restart-if-unhealthy</string>
    <string>--restart-stale-days=7</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>/tmp/fildi-logs/maintain-launchd.out</string>
  <key>StandardErrorPath</key><string>/tmp/fildi-logs/maintain-launchd.err</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed ${LABEL} → daily 7:00 local"
echo "  args: --enrich-if-due --drain-nr=40 --restart-if-unhealthy --restart-stale-days=7"
echo "  daily: missing-gold ≤30, earnings-window ≤40, FactSet drain ≤40 (if rem≥60),"
echo "         peer-health, merge+fund_score, retention prune, morning precompute,"
echo "         budget snapshot → enrichment_runs (Pipeline Health)"
echo "  full nightly-enrichment only if last success ≥4d (engine under maintain, not a 2nd calendar job)"
echo "  Set DISABLE_SCHEDULER_ENRICHMENT=1 in .env.local so api-server Sun/Thu in-process enrich stays off"
if ! grep -q 'DISABLE_SCHEDULER_ENRICHMENT' "${ROOT}/.env.local" 2>/dev/null; then
  echo 'DISABLE_SCHEDULER_ENRICHMENT=1' >> "${ROOT}/.env.local"
  echo "  appended DISABLE_SCHEDULER_ENRICHMENT=1 to .env.local"
fi
echo "  technicals/options: NOT scheduled — ad-hoc on UI click"
echo "  plist: $PLIST"
echo "  logs:  /tmp/fildi-logs/maintain-launchd.{out,err} + maintain-last.json"
echo "  one-shot now: node ${ROOT}/scripts/maintain.mjs --enrich-if-due"
echo "  uninstall: $0 --uninstall"
echo ""
echo "Note: lid closed (sleep) → launchd runs missed job on wake."
echo "      Mac fully powered off at 7:00 → runs next day Mac is on (or open before 8 and run manually)."
echo "      For always-on reliability use a small VPS / always-on Mac mini."
