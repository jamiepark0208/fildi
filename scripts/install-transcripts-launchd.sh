#!/usr/bin/env bash
# Earnings-call transcripts (Claude, user 2026-10-14) — daily 05:30 local; ≤ 20 Alpha Vantage calls/day (free cap 25).
# Output feeds Live › Portfolio Alerts › Your names.
# Install: ./scripts/install-transcripts-launchd.sh   ·   uninstall: --uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.fildi.transcripts"
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
    <string>${ROOT}/scripts/watchlist_sync/transcripts.py</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}/scripts/watchlist_sync</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>/tmp/fildi-logs/transcripts.out</string>
  <key>StandardErrorPath</key><string>/tmp/fildi-logs/transcripts.err</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed ${LABEL} → daily 05:30"
