#!/usr/bin/env bash
# Run ON the VM (via gcloud compute ssh): installs public-tick systemd timer.
# Mac: gcloud compute scp deploy/gcp … then ssh 'sudo bash /opt/fildi/deploy/gcp/install-public-tick.sh'
set -euo pipefail
install -d -m 0755 -o fildi -g fildi /opt/fildi/deploy/gcp
# ensure fildi can use peer auth to postgres
sudo -u postgres psql -d tradedash -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO fildi; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO fildi;" || true
# app_config may be missing on lean restore — create stub if needed
sudo -u postgres psql -d tradedash <<'SQL' || true
CREATE TABLE IF NOT EXISTS app_config (
  key text PRIMARY KEY,
  value text,
  updated_at timestamptz DEFAULT now()
);
GRANT ALL ON app_config TO fildi;
SQL
pip3 install --user psycopg2-binary 2>/dev/null || python3 -m pip install --user psycopg2-binary
# fildi user home may be /opt/fildi — install for that user
sudo -u fildi python3 -m pip install --user psycopg2-binary 2>/dev/null || true
cp -f /opt/fildi/deploy/gcp/fildi-public-tick.service /etc/systemd/system/
cp -f /opt/fildi/deploy/gcp/fildi-public-tick.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fildi-public-tick.timer
systemctl start fildi-public-tick.service || true
systemctl status fildi-public-tick.timer --no-pager || true
echo "OK: public tick timer enabled"
