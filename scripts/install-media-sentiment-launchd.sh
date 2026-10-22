#!/usr/bin/env bash
# Desk media sentiment (A214) — daily 08:30 local (after transcripts); StockTwits + call_tone → media_sentiment_daily.
# Display only. Install: ./scripts/install-media-sentiment-launchd.sh   ·   uninstall: --uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.fildi.media-sentiment"
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
    <string>${ROOT}/scripts/watchlist_sync/media_sentiment.py</string>
    <string>--limit</string>
    <string>100</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}/scripts/watchlist_sync</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>/tmp/fildi-logs/media-sentiment.out</string>
  <key>StandardErrorPath</key><string>/tmp/fildi-logs/media-sentiment.err</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed ${LABEL} → daily 08:30"
