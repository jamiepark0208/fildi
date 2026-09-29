#!/bin/bash
# Install a macOS LaunchAgent that runs lean maintenance DAILY (10:30 local).
# Does NOT keep a Node process alive — launchd starts it, it exits.
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
NODE="$(command -v node)"

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
    <string>--restart-if-unhealthy</string>
    <string>--restart-stale-days=7</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>10</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key><string>/tmp/fildi-logs/maintain-launchd.out</string>
  <key>StandardErrorPath</key><string>/tmp/fildi-logs/maintain-launchd.err</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed ${LABEL} → daily 10:30 local + --enrich-if-due"
echo "  plist: $PLIST"
echo "  logs:  /tmp/fildi-logs/maintain-launchd.{out,err}"
echo "  one-shot now: node ${ROOT}/scripts/maintain.mjs --enrich-if-due"
echo "  uninstall: $0 --uninstall"
echo ""
echo "Note: lid closed (sleep) → launchd runs missed job on wake."
echo "      Mac fully powered off at 10:30 → next day Mac is on; missing-fundamentals"
echo "      catch-up still runs daily when Mac is on; full enrich if last success ≥4d."
echo "      For always-on reliability use a small VPS / always-on Mac mini."
