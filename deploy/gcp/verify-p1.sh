#!/usr/bin/env bash
# A241 P1 pass bar — run on Mac after Cloud Shell provision finishes (~3 min).
# Usage: PROJECT=fildi-public ZONE=us-west1-b bash deploy/gcp/verify-p1.sh
set -euo pipefail
PROJECT="${PROJECT:-fildi-public}"
ZONE="${ZONE:-us-west1-b}"
INSTANCE="${INSTANCE:-fildi-public}"
KEY="${KEY:-$HOME/.ssh/id_ed25519}"

command -v gcloud >/dev/null || { echo "install gcloud: brew install --cask gcloud-cli"; exit 1; }
gcloud config set project "$PROJECT" >/dev/null
IP="$(gcloud compute instances describe "$INSTANCE" --zone="$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
[[ -n "$IP" ]] || { echo "no external IP"; exit 1; }
echo "IP=$IP"

echo -n "5432 external (must fail): "
if nc -z -w 2 "$IP" 5432 2>/dev/null; then echo "FAIL open"; exit 1; else echo "ok closed"; fi

echo -n "SSH key-only: "
ssh -i "$KEY" -o BatchMode=yes -o PasswordAuthentication=no -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=15 "fildi@$IP" 'test -f /var/lib/fildi-bootstrap-done && echo ok' || {
  echo "FAIL (bootstrap still running? retry in 1–2 min as ubuntu@$IP)"
  exit 1
}

echo "remote checks:"
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "fildi@$IP" \
  'echo "ss:"; ss -ltn | grep -E ":5432|:22" || true; echo "swap:"; free -h | grep -i swap; echo "pg:"; sudo -u postgres psql -c "SHOW listen_addresses;" 2>/dev/null || sudo ss -ltn | grep 5432'

echo "PASS A241 P1 (manual: confirm \$1 budget in Billing › Budgets)"
