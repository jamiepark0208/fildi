#!/usr/bin/env bash
# SUPERSEDED 2026-10-24 — Grok+Jamie already provisioned via cloudshell-setup.sh
# (project fildi-public-5ef5e2, VM fildi-public-1). Do not run this file on that
# account (would create a second project). Kept only as a draft; use:
#   bash deploy/gcp/cloudshell-setup.sh
#   bash deploy/gcp/verify-p1.sh   # after gcloud auth, PROJECT=fildi-public-5ef5e2
#
# A241 P1 — paste into Google Cloud Shell (browser). Creates project + free-tier VM.
# Free-tier traps asserted below: pd-standard (NOT Balanced), ephemeral IP (NOT static),
# us-west1, e2-micro, 30 GB disk.
#
# Usage (Cloud Shell):
#   bash <(curl -fsSL …)   # or paste this file, then:
#   bash provision-cloud-shell.sh
#
# Override pubkey: DEPLOY_PUBKEY='ssh-ed25519 AAAA… comment' bash provision-cloud-shell.sh
set -euo pipefail

PROJECT="${PROJECT:-fildi-public}"
REGION="${REGION:-us-west1}"
ZONE="${ZONE:-us-west1-b}"
INSTANCE="${INSTANCE:-fildi-public}"
DISK_GB="${DISK_GB:-30}"
MACHINE="${MACHINE:-e2-micro}"
DISK_TYPE="pd-standard"   # Balanced is NOT free-tier — do not change
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"  # optional; script lists if unset
# Mac Cursor deploy key (id_ed25519.pub) — public, safe to embed
DEPLOY_PUBKEY="${DEPLOY_PUBKEY:-ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEirqKWXDD8rwfYBq/dGouQciXs/ZMQmNMqm/BhvrIXd jamiepark@MacBook-Pro.local}"

die() { echo "FATAL: $*" >&2; exit 1; }

# --- free-tier assertions (fail closed) ---
[[ "$DISK_TYPE" == "pd-standard" ]] || die "disk type must be pd-standard (got $DISK_TYPE)"
[[ "$MACHINE" == "e2-micro" ]] || die "machine must be e2-micro (got $MACHINE)"
[[ "$REGION" == us-west1 || "$REGION" == us-central1 || "$REGION" == us-east1 ]] \
  || die "region must be a free-tier US region (got $REGION)"
[[ "$DISK_GB" -le 30 ]] || die "disk must be ≤30 GB for free tier (got $DISK_GB)"
[[ -n "$DEPLOY_PUBKEY" ]] || die "DEPLOY_PUBKEY empty"

command -v gcloud >/dev/null || die "gcloud missing — run this in Cloud Shell"

ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
[[ -n "$ACCOUNT" && "$ACCOUNT" != "(unset)" ]] || die "gcloud not logged in"

echo "==> account=$ACCOUNT project=$PROJECT zone=$ZONE"

# Billing
if [[ -z "$BILLING_ACCOUNT" ]]; then
  mapfile -t BILLS < <(gcloud billing accounts list --format='value(name)' 2>/dev/null || true)
  (( ${#BILLS[@]} >= 1 )) || die "no billing account — open console.cloud.google.com/billing and link a card"
  BILLING_ACCOUNT="${BILLS[0]}"
  echo "==> using billing account $BILLING_ACCOUNT"
fi

# Project
if ! gcloud projects describe "$PROJECT" &>/dev/null; then
  echo "==> creating project $PROJECT"
  gcloud projects create "$PROJECT" --name="Fildi public shadow" || true
fi
gcloud config set project "$PROJECT"
gcloud billing projects link "$PROJECT" --billing-account="$BILLING_ACCOUNT"

# APIs
gcloud services enable compute.googleapis.com cloudbilling.googleapis.com \
  cloudresourcemanager.googleapis.com logging.googleapis.com monitoring.googleapis.com

# Budget alert $1 (best-effort — API shape drifts)
if gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --filter="displayName:fildi-public-1usd" --format='value(name)' 2>/dev/null | grep -q .; then
  echo "==> budget alert already exists"
else
  echo "==> creating \$1 budget alert (best-effort)"
  gcloud billing budgets create \
    --billing-account="$BILLING_ACCOUNT" \
    --display-name="fildi-public-1usd" \
    --budget-amount=1USD \
    --threshold-rule=percent=50 \
    --threshold-rule=percent=90 \
    --threshold-rule=percent=100 \
    --filter-projects="projects/$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')" \
    2>/dev/null || echo "WARN: budget create failed — set \$1 alert manually in Billing › Budgets"
fi

# Firewall: SSH only (no 5432)
if ! gcloud compute firewall-rules describe allow-ssh-fildi --project="$PROJECT" &>/dev/null; then
  gcloud compute firewall-rules create allow-ssh-fildi \
    --project="$PROJECT" \
    --allow=tcp:22 \
    --source-ranges=0.0.0.0/0 \
    --target-tags=fildi-public \
    --description="A241: SSH only; Postgres never exposed"
fi
# Explicit deny note: default VPC allows some traffic; strip broad rules if present is out of scope —
# ufw on the guest is the real gate. Never open 5432:
if gcloud compute firewall-rules list --project="$PROJECT" --format='value(name,allowed)' | grep -E '5432' ; then
  die "a firewall rule mentions 5432 — remove it before continuing"
fi

# Startup script: harden + postgres 16 + fildi user
STARTUP="$(mktemp)"
cat >"$STARTUP" <<'EOS'
#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y unattended-upgrades fail2ban ufw curl ca-certificates gnupg lsb-release

# swap 2G
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# fildi user
id fildi &>/dev/null || useradd -m -s /bin/bash fildi
install -d -m 700 -o fildi -g fildi /home/fildi/.ssh
# pubkey injected below by outer script marker
grep -q 'fildi-gcp' /home/fildi/.ssh/authorized_keys 2>/dev/null || true

# sshd: key only, no root, no password
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
systemctl reload ssh || systemctl reload sshd || true

# ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

# fail2ban
systemctl enable --now fail2ban

# Postgres 16 (same major as Mac Postgres.app 16.x)
if ! command -v psql >/dev/null; then
  install -d /usr/share/keyrings
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg
  echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y
  apt-get install -y postgresql-16
fi

# listen localhost only + small-RAM knobs
PGCONF="$(ls /etc/postgresql/16/main/postgresql.conf 2>/dev/null || true)"
if [[ -n "$PGCONF" ]] && ! grep -q 'A241 e2-micro' "$PGCONF"; then
  sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost'/" "$PGCONF"
  cat >>"$PGCONF" <<'PG'
# A241 e2-micro
shared_buffers = 128MB
work_mem = 4MB
maintenance_work_mem = 64MB
max_connections = 20
effective_cache_size = 384MB
PG
  # pg_hba: local + 127.0.0.1 only
  HBA="$(dirname "$PGCONF")/pg_hba.conf"
  cat >"$HBA" <<'HBA'
local   all             postgres                                peer
local   all             all                                     peer
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
HBA
  systemctl enable postgresql
  systemctl restart postgresql
elif [[ -n "$PGCONF" ]]; then
  systemctl enable postgresql
  systemctl start postgresql || true
fi

install -d -m 750 -o root -g fildi /etc/fildi
touch /etc/fildi/env
chown root:fildi /etc/fildi/env
chmod 0640 /etc/fildi/env

# unattended upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades || true

touch /var/lib/fildi-bootstrap-done
EOS

# Inject deploy pubkey into startup (authorized_keys for fildi + ubuntu)
# Cloud Shell metadata startup runs as root before first login.
PUB_ESC=$(printf '%s' "$DEPLOY_PUBKEY" | sed "s/'/'\\\\''/g")
cat >>"$STARTUP" <<EOF

# --- deploy pubkey (A241) ---
install -d -m 700 -o fildi -g fildi /home/fildi/.ssh
echo '$PUB_ESC' > /home/fildi/.ssh/authorized_keys
chown fildi:fildi /home/fildi/.ssh/authorized_keys
chmod 600 /home/fildi/.ssh/authorized_keys
if id ubuntu &>/dev/null; then
  install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
  echo '$PUB_ESC' > /home/ubuntu/.ssh/authorized_keys
  chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
  chmod 600 /home/ubuntu/.ssh/authorized_keys
fi
EOF

# Create VM — ephemeral external IP (do NOT reserve a static address)
if gcloud compute instances describe "$INSTANCE" --zone="$ZONE" --project="$PROJECT" &>/dev/null; then
  echo "==> instance $INSTANCE already exists — skipping create"
else
  echo "==> creating $MACHINE $INSTANCE ($DISK_TYPE ${DISK_GB}GB) — ephemeral IP only"
  # Refuse Balanced disk if someone edits DISK_TYPE above
  gcloud compute instances create "$INSTANCE" \
    --project="$PROJECT" \
    --zone="$ZONE" \
    --machine-type="$MACHINE" \
    --image-family=ubuntu-2404-lts-amd64 \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size="${DISK_GB}GB" \
    --boot-disk-type="$DISK_TYPE" \
    --tags=fildi-public \
    --metadata=enable-oslogin=FALSE \
    --metadata-from-file=startup-script="$STARTUP" \
    --scopes=cloud-platform
fi

rm -f "$STARTUP"

IP="$(gcloud compute instances describe "$INSTANCE" --zone="$ZONE" --project="$PROJECT" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
echo
echo "=== A241 P1 provisioned ==="
echo "project:  $PROJECT"
echo "instance: $INSTANCE"
echo "zone:     $ZONE"
echo "external: $IP"
echo "ssh:      ssh -i ~/.ssh/id_ed25519 fildi@$IP"
echo
echo "Pass checks (from Mac after ~3 min bootstrap):"
echo "  nc -z -w 2 $IP 5432; echo exit=\$?   # must FAIL (nonzero)"
echo "  ssh -o BatchMode=yes -o PasswordAuthentication=no fildi@$IP 'ss -ltn | grep 5432; free -h | grep -i swap'"
echo "  gcloud billing budgets list --billing-account=$BILLING_ACCOUNT"
echo
echo "NOTE: never reserve a static IP for this VM (billed when unused)."
