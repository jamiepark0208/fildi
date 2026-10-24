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
