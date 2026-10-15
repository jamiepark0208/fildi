#!/usr/bin/env bash
# PM alerts (Claude, user 2026-10-14) — fires every 15 min; pm_alerts.py runs each time in market hours, every 2 h otherwise.
# Output feeds Live › Portfolio Alerts (no push notifications).
# Install: ./scripts/install-pm-alerts-launchd.sh   ·   uninstall: --uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.fildi.pm-alerts"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

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
    <string>${ROOT}/scripts/watchlist_sync/.venv/bin/python</string>
    <string>${ROOT}/scripts/watchlist_sync/pm_alerts.py</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}/scripts/watchlist_sync</string>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/tmp/fildi-logs/pm-alerts.out</string>
  <key>StandardErrorPath</key><string>/tmp/fildi-logs/pm-alerts.err</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed ${LABEL} → every 15 min in market hours, 2 h otherwise"
