#!/usr/bin/env bash
# Fildi A241 P1: provision ONE always-free e2-micro VM. Run in Google Cloud Shell:
#   bash cloudshell-setup.sh
# Idempotent: re-run any time; it skips what already exists and re-checks the rest.
# Touches nothing on the Mac. Copies no data. Contains no secrets.
# Generated from cloudshell-setup.template.sh + vm-bootstrap.sh by build.sh.
set -euo pipefail

# ------------------------------------------------------------------ config
# Override any of these with env vars, e.g.  ZONE=us-west1-a bash cloudshell-setup.sh
PROJECT_ID="${PROJECT_ID:-}"                 # empty -> reuse saved id, else create fildi-public-xxxxxx
USE_CURRENT_PROJECT="${USE_CURRENT_PROJECT:-0}"   # 1 -> use `gcloud config get-value project`
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"       # empty -> project's linked account, or the only open one
REGION="${REGION:-us-west1}"                 # Oregon, closest free-tier region to LA
ZONE="${ZONE:-us-west1-b}"
INSTANCE="${INSTANCE:-fildi-public-1}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"
DISK_TYPE="${DISK_TYPE:-pd-standard}"
DISK_GB="${DISK_GB:-30}"
IMAGE_FAMILY="${IMAGE_FAMILY:-debian-12}"
IMAGE_PROJECT="${IMAGE_PROJECT:-debian-cloud}"
NETWORK_TIER="${NETWORK_TIER:-STANDARD}"     # STANDARD: 200 GiB/mo free egress; PREMIUM: 1 GB/mo free
NETWORK="${NETWORK:-fildi-vpc}"
SUBNET="${SUBNET:-fildi-${REGION}}"
SUBNET_RANGE="${SUBNET_RANGE:-10.10.0.0/24}"
SSH_SOURCE_RANGES="${SSH_SOURCE_RANGES:-0.0.0.0/0}"   # key-only SSH; narrow later if you like
SSH_TAG="fildi-ssh"
# SSH access mode:
#   empty SSH_PUBKEY -> OS Login (Google account controls SSH keys; key-only)
#   SSH_PUBKEY="ssh-ed25519 AAAA... fildi-deploy" -> that one PUBLIC key for user $SSH_USER
SSH_PUBKEY="${SSH_PUBKEY:-}"
SSH_USER="${SSH_USER:-fildiadmin}"
BUDGET_NAME="${BUDGET_NAME:-fildi-1usd-alert}"
BUDGET_AMOUNT="${BUDGET_AMOUNT:-1}"          # in the billing account's currency (USD)
PG_MAJOR="${PG_MAJOR:-16}"                   # TODO(P0): match Mac `psql -V`; repo hints 16
ALLOW_OTHER_VMS="${ALLOW_OTHER_VMS:-0}"
STATE_FILE="${HOME}/.fildi-gcp-project"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   ok: %s\n' "$*"; }
die()  { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

# -------------------------------------------------- free-tier guardrails
# Always Free (cloud.google.com/free/docs/free-cloud-features#compute):
# 1 non-preemptible e2-micro in us-west1 | us-central1 | us-east1, 30 GB-months
# standard persistent disk, no GPU/TPU.
say "Free-tier guardrails"
[[ "${MACHINE_TYPE}" == "e2-micro" ]] || die "MACHINE_TYPE=${MACHINE_TYPE}; only e2-micro is free"
[[ "${DISK_TYPE}" == "pd-standard" ]] || die "DISK_TYPE=${DISK_TYPE}; only pd-standard is free (not pd-balanced/ssd)"
if [[ ! "${DISK_GB}" =~ ^[0-9]+$ ]] || (( DISK_GB < 10 || DISK_GB > 30 )); then
  die "DISK_GB=${DISK_GB}; must be 10..30 (free tier = 30 GB-months pd-standard)"
fi
case "${REGION}" in us-west1|us-central1|us-east1) ;; *) die "REGION=${REGION}; free tier is us-west1, us-central1, us-east1 only";; esac
[[ "${ZONE}" == "${REGION}-"[a-z] ]] || die "ZONE=${ZONE} is not in REGION=${REGION}"
case "${NETWORK_TIER}" in STANDARD|PREMIUM) ;; *) die "NETWORK_TIER must be STANDARD or PREMIUM";; esac
[[ "${PG_MAJOR}" =~ ^[0-9]{2}$ ]] || die "PG_MAJOR=${PG_MAJOR} not a major version"
if [[ -n "${SSH_PUBKEY}" ]]; then
  [[ "${SSH_PUBKEY}" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)\ [A-Za-z0-9+/=]+(\ .*)?$ ]] \
    || die "SSH_PUBKEY must be ONE public key line (ssh-ed25519 AAAA...). Never paste a private key."
  [[ "${SSH_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "bad SSH_USER"
fi
ok "${MACHINE_TYPE} / ${DISK_TYPE} ${DISK_GB}GB / ${ZONE} / ${NETWORK_TIER} tier / no GPU / non-preemptible"
[[ "${CLOUD_SHELL:-}" == "true" ]] || echo "   note: not in Cloud Shell; continuing with your local gcloud"

ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)"
[[ -n "${ACCOUNT}" ]] || die "gcloud not signed in (run: gcloud auth login)"
ok "signed in as ${ACCOUNT}"

# ----------------------------------------------------------------- project
say "Project"
if [[ -z "${PROJECT_ID}" && "${USE_CURRENT_PROJECT}" == "1" ]]; then
  PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
fi
if [[ -z "${PROJECT_ID}" && -s "${STATE_FILE}" ]]; then
  PROJECT_ID="$(cat "${STATE_FILE}")"
fi
if [[ -z "${PROJECT_ID}" ]]; then
  PROJECT_ID="fildi-public-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
fi
if gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  ok "using existing project ${PROJECT_ID}"
else
  gcloud projects create "${PROJECT_ID}" --name="Fildi public" --labels=app=fildi
  ok "created project ${PROJECT_ID}"
fi
echo "${PROJECT_ID}" > "${STATE_FILE}"
gcloud config set project "${PROJECT_ID}" >/dev/null
G=(--project="${PROJECT_ID}")

# ----------------------------------------------------------------- billing
say "Billing"
LINKED="$(gcloud billing projects describe "${PROJECT_ID}" --format='value(billingAccountName)' 2>/dev/null || true)"
LINKED="${LINKED#billingAccounts/}"
if [[ -z "${BILLING_ACCOUNT}" ]]; then
  if [[ -n "${LINKED}" ]]; then
    BILLING_ACCOUNT="${LINKED}"
  else
    mapfile -t OPEN < <(gcloud billing accounts list --filter='open=true' --format='value(name)')
    (( ${#OPEN[@]} == 1 )) || die "found ${#OPEN[@]} open billing accounts; re-run with BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX (card verification may still be pending)"
    BILLING_ACCOUNT="${OPEN[0]#billingAccounts/}"
  fi
fi
BILLING_ACCOUNT="${BILLING_ACCOUNT#billingAccounts/}"
if [[ "${LINKED}" != "${BILLING_ACCOUNT}" ]]; then
  gcloud billing projects link "${PROJECT_ID}" --billing-account="${BILLING_ACCOUNT}" >/dev/null
fi
[[ "$(gcloud billing projects describe "${PROJECT_ID}" --format='value(billingEnabled)')" == "True" ]] \
  || die "billing not enabled on ${PROJECT_ID}"
ok "billing account ${BILLING_ACCOUNT} linked"

say "APIs (first time takes ~1 min)"
gcloud services enable compute.googleapis.com billingbudgets.googleapis.com "${G[@]}"
ok "compute + billingbudgets enabled"

# ------------------------------------------------------------------ budget
say "Budget alert (\$${BUDGET_AMOUNT}/month, emails billing admins = you)"
if gcloud billing budgets list --billing-account="${BILLING_ACCOUNT}" --billing-project="${PROJECT_ID}" \
     --format='value(displayName)' | grep -qx "${BUDGET_NAME}"; then
  ok "budget ${BUDGET_NAME} already exists"
else
  gcloud billing budgets create --billing-account="${BILLING_ACCOUNT}" --billing-project="${PROJECT_ID}" \
    --display-name="${BUDGET_NAME}" --budget-amount="${BUDGET_AMOUNT}" --calendar-period=month \
    --threshold-rule=percent=0.01 --threshold-rule=percent=0.5 --threshold-rule=percent=1.0 \
    --threshold-rule=percent=1.0,basis=forecasted-spend >/dev/null
  ok "budget ${BUDGET_NAME} created (alerts at 1%, 50%, 100% actual + 100% forecast)"
fi
echo "   note: a budget only ALERTS. Google never auto-stops spend."

# ---------------------------------------------------------- project state guard
say "Existing resources check"
EXISTS=0
if gcloud compute instances describe "${INSTANCE}" --zone="${ZONE}" "${G[@]}" >/dev/null 2>&1; then EXISTS=1; fi
OTHERS="$(gcloud compute instances list "${G[@]}" --format='value(name)' | grep -vx "${INSTANCE}" || true)"
if [[ -n "${OTHERS}" && "${ALLOW_OTHER_VMS}" != "1" ]]; then
  die "project already has other VMs (${OTHERS//$'\n'/, }). Free tier = one e2-micro's hours per month per billing account. Delete them or set ALLOW_OTHER_VMS=1."
fi
USED_GB=0
while read -r name size type; do
  [[ -z "${name}" || "${name}" == "${INSTANCE}" ]] && continue
  [[ "${type##*/}" == "pd-standard" ]] && USED_GB=$(( USED_GB + size ))
done < <(gcloud compute disks list "${G[@]}" --format='value(name,sizeGb,type)')
(( USED_GB + DISK_GB <= 30 )) || die "pd-standard total would be $(( USED_GB + DISK_GB )) GB > 30 GB free"
ok "no other VMs; pd-standard total stays <= 30 GB"
echo "   note: free hours are per BILLING ACCOUNT. Other projects on it must not run e2-micros."

gcloud compute images describe-from-family "${IMAGE_FAMILY}" --project="${IMAGE_PROJECT}" \
  --format='value(name)' >/dev/null || die "image family ${IMAGE_PROJECT}/${IMAGE_FAMILY} not found"
ok "image ${IMAGE_PROJECT}/${IMAGE_FAMILY}"

# ----------------------------------------------------------------- network
say "Network + firewall (ingress: tcp:22 only)"
gcloud compute networks describe "${NETWORK}" "${G[@]}" >/dev/null 2>&1 \
  || gcloud compute networks create "${NETWORK}" --subnet-mode=custom "${G[@]}" >/dev/null
gcloud compute networks subnets describe "${SUBNET}" --region="${REGION}" "${G[@]}" >/dev/null 2>&1 \
  || gcloud compute networks subnets create "${SUBNET}" --network="${NETWORK}" --region="${REGION}" \
       --range="${SUBNET_RANGE}" "${G[@]}" >/dev/null
if gcloud compute firewall-rules describe fildi-allow-ssh "${G[@]}" >/dev/null 2>&1; then
  gcloud compute firewall-rules update fildi-allow-ssh --rules=tcp:22 \
    --source-ranges="${SSH_SOURCE_RANGES}" --target-tags="${SSH_TAG}" "${G[@]}" >/dev/null
else
  gcloud compute firewall-rules create fildi-allow-ssh --network="${NETWORK}" --direction=INGRESS \
    --action=ALLOW --rules=tcp:22 --source-ranges="${SSH_SOURCE_RANGES}" --target-tags="${SSH_TAG}" \
    --priority=1000 "${G[@]}" >/dev/null
fi
gcloud compute firewall-rules describe fildi-deny-all-ingress "${G[@]}" >/dev/null 2>&1 \
  || gcloud compute firewall-rules create fildi-deny-all-ingress --network="${NETWORK}" --direction=INGRESS \
       --action=DENY --rules=all --source-ranges=0.0.0.0/0 --priority=65000 "${G[@]}" >/dev/null
EXTRA=""
while read -r fw_name fw_net fw_dir; do
  [[ "${fw_net}" == "${NETWORK}" && "${fw_dir}" == "INGRESS" ]] || continue
  case "${fw_name}" in fildi-allow-ssh|fildi-deny-all-ingress) ;; *) EXTRA="${EXTRA} ${fw_name}";; esac
done < <(gcloud compute firewall-rules list "${G[@]}" --format='value(name,network.basename(),direction)')
[[ -z "${EXTRA}" ]] || die "unexpected ingress rules on ${NETWORK}:${EXTRA}"
ok "${NETWORK}: allow tcp:22 (${SSH_SOURCE_RANGES}) -> tag ${SSH_TAG}; deny all other ingress"

# ---------------------------------------------------------------- VM
say "VM ${INSTANCE}"
TMPD="$(mktemp -d)"
trap 'rm -rf "${TMPD}"' EXIT
cat > "${TMPD}/startup.sh" <<'FILDI_BOOTSTRAP_EOF'
#!/usr/bin/env bash
# Fildi public VM bootstrap (A241 phase P1). Runs as root on the public VM:
# GCE e2-micro (startup-script, every boot) or AWS EC2 (user-data, first boot),
# Debian 12 or Ubuntu 24.04, amd64 or arm64. Or by hand over SSH:
#   sudo bash vm-bootstrap.sh
# Idempotent: safe to re-run. Installs NO data and NO jobs (P2/P3 come after
# the A227 security gate). Holds no secrets: /etc/fildi/env is an empty template.
set -euo pipefail

# TODO(P0): confirm the Mac's Postgres major with `psql -V` on the Mac.
# Repo hint: a fildi script hard-codes Postgres.app/Contents/Versions/16 -> default 16.
# Order: env PG_MAJOR (AWS user-data header) > GCE metadata "pg-major" > 16.
if [[ -z "${PG_MAJOR:-}" ]] && grep -qs Google /sys/class/dmi/id/product_name; then
  PG_MAJOR="$(curl -fs --max-time 3 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/attributes/pg-major || true)"
fi
PG_MAJOR="${PG_MAJOR:-16}"
if [[ ! "${PG_MAJOR}" =~ ^[0-9]{2}$ ]]; then
  echo "bad PG_MAJOR '${PG_MAJOR}'" >&2
  exit 1
fi
SWAP_SIZE_MB="${SWAP_SIZE_MB:-2048}"
FILDI_DB="${FILDI_DB:-tradedash}"
LOG=/var/log/fildi-bootstrap.log

if [[ ${EUID} -ne 0 ]]; then
  echo "run as root (sudo bash $0)" >&2
  exit 1
fi
exec > >(tee -a "${LOG}") 2>&1
echo "=== fildi bootstrap start $(date -Is) PG_MAJOR=${PG_MAJOR}"

# shellcheck disable=SC1091
. /etc/os-release
case "${ID}/${VERSION_CODENAME}" in
  debian/bookworm|ubuntu/noble) ;;
  *) echo "WARN: built for Debian 12 / Ubuntu 24.04, found ${ID} ${VERSION_CODENAME}; continuing" ;;
esac
echo "os=${ID}/${VERSION_CODENAME} arch=$(dpkg --print-architecture)"

export DEBIAN_FRONTEND=noninteractive
APT=(apt-get -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

# ---------------------------------------------------------------- packages
apt-get -o DPkg::Lock::Timeout=600 update -q
"${APT[@]}" install unattended-upgrades apt-listchanges ufw fail2ban python3-systemd \
  curl ca-certificates gnupg postgresql-common

# ---------------------------------------------------- unattended upgrades
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat > /etc/apt/apt.conf.d/52fildi-unattended <<'CONF'
// Distro security updates come from the 50unattended-upgrades defaults.
// Also take PGDG minor releases (same major only; majors never auto-change).
Unattended-Upgrade::Origins-Pattern {
        "origin=apt.postgresql.org";
};
Unattended-Upgrade::Remove-Unused-Dependencies "true";
// No surprise reboots on a single-VM box; kernel updates apply on next manual reboot.
Unattended-Upgrade::Automatic-Reboot "false";
CONF
systemctl enable --now unattended-upgrades

# ------------------------------------------------------------------ swap
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l "${SWAP_SIZE_MB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="${SWAP_SIZE_MB}"
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
cat > /etc/sysctl.d/90-fildi.conf <<'CONF'
vm.swappiness = 10
vm.vfs_cache_pressure = 50
CONF
sysctl --quiet --system

# ------------------------------------------------------------------- sshd
# Drop-in is read first (Include at top of Debian's sshd_config) -> first match wins.
cat > /etc/ssh/sshd_config.d/10-fildi-hardening.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
PermitEmptyPasswords no
X11Forwarding no
AllowAgentForwarding no
MaxAuthTries 3
LoginGraceTime 30
CONF
install -d -m 0755 /run/sshd   # Ubuntu socket activation may not have created it yet
sshd -t
# Ubuntu 24.04 socket-activates ssh; try-reload is a no-op if the service is idle
# (the next connection reads the new config anyway).
systemctl try-reload-or-restart ssh

# -------------------------------------------------------------------- ufw
ufw --force default deny incoming
ufw --force default allow outgoing
ufw allow 22/tcp comment 'ssh'
ufw --force enable

# --------------------------------------------------------------- fail2ban
# bookworm has no /var/log/auth.log by default -> use the journal.
cat > /etc/fail2ban/jail.d/fildi-sshd.local <<'CONF'
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
CONF
systemctl enable fail2ban
systemctl restart fail2ban

# ----------------------------------------------------------- fildi user
if ! id fildi >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /opt/fildi --shell /usr/sbin/nologin fildi
fi
install -d -m 0750 -o root -g fildi /etc/fildi
if [[ ! -f /etc/fildi/env ]]; then
  # Template only: names, no values. Never overwrite once Cursor fills it in.
  cat > /etc/fildi/env <<'CONF'
# Fildi public VM env (A241). Filled by Cursor in P3, never committed to git.
# NEVER put Schwab / Robinhood / LSEG / WRDS / FactSet credentials here.
FILDI_HOST_ROLE=public
# Local socket, peer auth, no password, e.g. postgresql:///tradedash?host=/var/run/postgresql
DATABASE_URL=
# Separate VM-only free-tier keys (not the Mac's), per A241 quota guard:
FMP_API_KEY=
FINNHUB_API_KEY=
POLYGON_API_KEY=
ALPHA_VANTAGE_API_KEY=
# Anthropic key with a hard monthly spend cap:
ANTHROPIC_API_KEY=
CONF
fi
chown fildi:fildi /etc/fildi/env
chmod 0600 /etc/fildi/env

# --------------------------------------------------------------- postgres
# PGDG repo, manual method from postgresql.org/download/linux/debian (bookworm-pgdg).
PGDG_KEY=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
if [[ ! -s "${PGDG_KEY}" ]]; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o "${PGDG_KEY}" https://www.postgresql.org/media/keys/ACCC4CF8.asc
fi
cat > /etc/apt/sources.list.d/pgdg.sources <<CONF
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: ${VERSION_CODENAME}-pgdg
Components: main
Signed-By: ${PGDG_KEY}
CONF
apt-get -o DPkg::Lock::Timeout=600 update -q
"${APT[@]}" install "postgresql-${PG_MAJOR}"

PGCONF="/etc/postgresql/${PG_MAJOR}/main"
install -d -m 0755 -o postgres -g postgres "${PGCONF}/conf.d"
cat > "${PGCONF}/conf.d/10-fildi.conf" <<'CONF'
# Fildi: localhost only, tuned for e2-micro (1 GB RAM, 0.25 vCPU sustained, pd-standard).
listen_addresses = 'localhost'
port = 5432
max_connections = 20
shared_buffers = 128MB
effective_cache_size = 384MB
work_mem = 4MB
maintenance_work_mem = 64MB
wal_buffers = 4MB
max_wal_size = 512MB
min_wal_size = 64MB
checkpoint_completion_target = 0.9
huge_pages = off
max_worker_processes = 2
max_parallel_workers = 1
max_parallel_workers_per_gather = 0
max_parallel_maintenance_workers = 1
autovacuum_max_workers = 2
effective_io_concurrency = 2
random_page_cost = 4
password_encryption = scram-sha-256
log_min_duration_statement = 2000
CONF
cat > "${PGCONF}/pg_hba.conf" <<'CONF'
# Fildi: unix socket + loopback only. No remote hosts, no replication.
# TYPE  DATABASE  USER      ADDRESS         METHOD
local   all       postgres                  peer
local   all       all                       peer
host    all       all       127.0.0.1/32    scram-sha-256
host    all       all       ::1/128         scram-sha-256
CONF
chown postgres:postgres "${PGCONF}/pg_hba.conf"
chmod 0640 "${PGCONF}/pg_hba.conf"
systemctl enable "postgresql@${PG_MAJOR}-main"
systemctl restart "postgresql@${PG_MAJOR}-main"

# Empty role + DB for the fildi user (peer auth over the socket). No data.
for _ in $(seq 1 15); do
  runuser -u postgres -- pg_isready -q && break
  sleep 2
done
runuser -u postgres -- psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname='fildi'" | grep -q 1 \
  || runuser -u postgres -- psql -qc "CREATE ROLE fildi LOGIN"
runuser -u postgres -- psql -qtAc "SELECT 1 FROM pg_database WHERE datname='${FILDI_DB}'" | grep -q 1 \
  || runuser -u postgres -- createdb -O fildi "${FILDI_DB}"

# ------------------------------------------------------------ self-check
fail=0
# sshd -T can fail early in first boot (host keys not ready); retry up to 60s.
for _ in $(seq 1 30); do sshd -T >/dev/null 2>&1 && break; sleep 2; done
if ss -Hltn 'sport = :5432' | awk '{print $4}' | grep -Ev '^(127\.0\.0\.1|\[::1\]):5432$' | grep -q .; then
  echo "FAIL: postgres listening beyond localhost"; fail=1
fi
# Capture first: grep -q exits early -> SIGPIPE on sshd -> pipefail false-fail.
SSHD_T="$(sshd -T 2>/dev/null || true)"
grep -qx 'passwordauthentication no' <<<"${SSHD_T}" || { echo "FAIL: sshd password auth"; fail=1; }
grep -qx 'permitrootlogin no' <<<"${SSHD_T}" || { echo "FAIL: sshd root login"; fail=1; }
ufw status | grep -q 'Status: active' || { echo "FAIL: ufw inactive"; fail=1; }
grep -qx /swapfile <<<"$(swapon --show=NAME --noheadings)" || { echo "FAIL: swap"; fail=1; }
[[ "$(stat -c '%a %U' /etc/fildi/env)" == "600 fildi" ]] || { echo "FAIL: env perms"; fail=1; }
runuser -u postgres -- psql -qtAc 'SHOW server_version' | sed 's/^/postgres server_version: /'

if [[ ${fail} -ne 0 ]]; then
  echo "=== fildi bootstrap FAILED self-check $(date -Is)"
  exit 1
fi
install -d -m 0755 /var/lib/fildi
date -Is > /var/lib/fildi/bootstrap.ok
echo "=== fildi bootstrap OK $(date -Is)"
FILDI_BOOTSTRAP_EOF
META_FILES="startup-script=${TMPD}/startup.sh"
if [[ -n "${SSH_PUBKEY}" ]]; then
  printf '%s:%s\n' "${SSH_USER}" "${SSH_PUBKEY}" > "${TMPD}/ssh-keys"
  META_FILES="${META_FILES},ssh-keys=${TMPD}/ssh-keys"
  META="enable-oslogin=FALSE,block-project-ssh-keys=TRUE,pg-major=${PG_MAJOR}"
else
  META="enable-oslogin=TRUE,block-project-ssh-keys=TRUE,pg-major=${PG_MAJOR}"
fi

if [[ ${EXISTS} -eq 1 ]]; then
  ok "already exists; not recreating. Refreshing startup-script + metadata."
  gcloud compute instances add-metadata "${INSTANCE}" --zone="${ZONE}" "${G[@]}" \
    --metadata="${META}" --metadata-from-file="${META_FILES}" >/dev/null
else
  gcloud compute instances create "${INSTANCE}" "${G[@]}" --zone="${ZONE}" \
    --machine-type="${MACHINE_TYPE}" --provisioning-model=STANDARD --maintenance-policy=MIGRATE \
    --image-family="${IMAGE_FAMILY}" --image-project="${IMAGE_PROJECT}" \
    --boot-disk-type="${DISK_TYPE}" --boot-disk-size="${DISK_GB}GB" \
    --network="${NETWORK}" --subnet="${SUBNET}" --network-tier="${NETWORK_TIER}" --stack-type=IPV4_ONLY \
    --tags="${SSH_TAG}" --no-service-account --no-scopes \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --labels=app=fildi,role=public,plan=a241 \
    --metadata="${META}" --metadata-from-file="${META_FILES}" >/dev/null
  ok "created"
fi

# ------------------------------------------------------- verify what exists
say "Verify"
read -r MT ZN <<<"$(gcloud compute instances describe "${INSTANCE}" --zone="${ZONE}" "${G[@]}" \
  --format='value(machineType.basename(),zone.basename())')"
read -r DT DS <<<"$(gcloud compute disks describe "${INSTANCE}" --zone="${ZONE}" "${G[@]}" \
  --format='value(type.basename(),sizeGb)')"
GPU="$(gcloud compute instances describe "${INSTANCE}" --zone="${ZONE}" "${G[@]}" --format='value(guestAccelerators)')"
SCHED="$(gcloud compute instances describe "${INSTANCE}" --zone="${ZONE}" "${G[@]}" --format='value(scheduling.preemptible)')"
[[ "${MT}" == "e2-micro" && "${ZN}" == "${ZONE}" ]] || die "VM is ${MT} in ${ZN}: NOT free tier. Delete it: gcloud compute instances delete ${INSTANCE} --zone=${ZN}"
if [[ "${DT}" != "pd-standard" ]] || (( DS > 30 )); then
  die "boot disk is ${DT} ${DS}GB: NOT free tier"
fi
[[ -z "${GPU}" ]] || die "GPU attached: NOT free"
[[ "${SCHED}" != "True" ]] || die "VM is preemptible: NOT free tier"
IP="$(gcloud compute instances describe "${INSTANCE}" --zone="${ZONE}" "${G[@]}" \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
ok "${MT} ${ZN}, ${DT} ${DS}GB, no GPU, non-preemptible"

cat <<NEXT

==================== DONE ====================
project   : ${PROJECT_ID}
zone      : ${ZONE}
vm        : ${INSTANCE}
external IP: ${IP}   (ephemeral; may change after stop/start)
budget    : ${BUDGET_NAME} (\$${BUDGET_AMOUNT}/mo, email alerts)
ssh mode  : $([[ -n "${SSH_PUBKEY}" ]] && echo "metadata key for ${SSH_USER}" || echo "OS Login")

Next (wait ~5 min for bootstrap):
  1. Watch bootstrap finish:
     gcloud compute instances get-serial-port-output ${INSTANCE} --zone=${ZONE} | grep 'fildi bootstrap'
     -> want: "=== fildi bootstrap OK"
  2. Send Grok ONLY these 3 lines (no keys, no passwords):
     project=${PROJECT_ID} zone=${ZONE} ip=${IP}
  3. Do nothing else. Your Mac is unchanged. Cursor does P2/P3 after the security gate.
NEXT
