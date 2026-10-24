#!/usr/bin/env bash
# A241 P1 pass bar — Mac, after Grok/Jamie Cloud Shell provision.
# Matches Grok's live VM (A241.md): project fildi-public-5ef5e2, VM fildi-public-1.
# Usage: gcloud auth login && bash deploy/gcp/verify-p1.sh
# Prefer OS Login (Grok default): gcloud compute ssh (no raw key needed).
set -euo pipefail
PROJECT="${PROJECT:-fildi-public-5ef5e2}"
ZONE="${ZONE:-us-west1-b}"
INSTANCE="${INSTANCE:-fildi-public-1}"

command -v gcloud >/dev/null || { echo "install gcloud: brew install --cask gcloud-cli"; exit 1; }
gcloud config set project "$PROJECT" >/dev/null
IP="$(gcloud compute instances describe "$INSTANCE" --zone="$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
[[ -n "$IP" ]] || { echo "no external IP — auth / project wrong?"; exit 1; }
echo "project=$PROJECT zone=$ZONE instance=$INSTANCE ip=$IP"

echo -n "machine/disk: "
gcloud compute instances describe "$INSTANCE" --zone="$ZONE" --format='value(machineType.basename())'
gcloud compute disks describe "$INSTANCE" --zone="$ZONE" --format='value(type.basename(),sizeGb)' || true

echo -n "5432 external (must fail): "
if nc -z -w 2 "$IP" 5432 2>/dev/null; then echo "FAIL open"; exit 1; else echo "ok closed"; fi

echo -n "22 open: "
if nc -z -w 2 "$IP" 22 2>/dev/null; then echo "ok"; else echo "FAIL closed"; exit 1; fi

echo "remote (OS Login via gcloud compute ssh):"
gcloud compute ssh "$INSTANCE" --zone="$ZONE" --command='
  set -e
  echo "ss:"; sudo ss -ltn | grep -E ":5432|:22" || true
  echo "swap:"; free -h | grep -i swap
  echo "sshd:"; sudo sshd -T | grep -E "^(passwordauthentication|permitrootlogin) " || true
  echo "pg:"; sudo -u postgres psql -tAc "show listen_addresses; show server_version"
  echo "env:"; sudo stat -c "%a %U:%G" /etc/fildi/env
  if [[ -f /var/lib/fildi/bootstrap.ok ]] || grep -q "fildi bootstrap OK" /var/log/fildi-bootstrap.log 2>/dev/null; then
    echo bootstrap=ok
  else
    echo bootstrap=missing
  fi
'

echo "budget channel:"
gcloud billing budgets describe 26de4eea-d39f-49ad-b2dc-2c4ff282dfbd \
  --billing-account=0164D0-C77B02-FCE300 --billing-project="$PROJECT" \
  --format='value(notificationsRule.monitoringNotificationChannels.list())' 2>/dev/null || true

echo "PASS A241 P1 verify"
