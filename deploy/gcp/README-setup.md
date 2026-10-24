# Fildi Google server: Jamie steps (A241 P1)

1. Card verified? Open https://console.cloud.google.com, click **>_** (top right) = Cloud Shell.
2. In Cloud Shell: **⋮ → Upload**, pick `cloudshell-setup.sh`.
3. Type: `bash cloudshell-setup.sh`  (if it asks to authorize, click Authorize).
4. Wait for **DONE**. Red **STOP** = paste the red line to Grok, nothing was charged.
5. Send Grok the `project= zone= ip=` line. No keys, no passwords. Done. Mac untouched.

---

## Grok verify checklist (after Jamie sends project/zone/ip)

Run in Cloud Shell (Jamie) or any gcloud with read access. All must pass.

- [ ] VM: `gcloud compute instances describe fildi-public-1 --zone=us-west1-b --format='value(machineType.basename(),scheduling.preemptible,guestAccelerators)'` → `e2-micro  False` and no GPU
- [ ] Disk: `gcloud compute disks describe fildi-public-1 --zone=us-west1-b --format='value(type.basename(),sizeGb)'` → `pd-standard 30`
- [ ] Only one VM in project: `gcloud compute instances list` → 1 row
- [ ] Network tier: `...instances describe ... --format='value(networkInterfaces[0].accessConfigs[0].networkTier)'` → `STANDARD`
- [ ] No service account on VM: `...--format='value(serviceAccounts)'` → empty
- [ ] Firewall: `gcloud compute firewall-rules list --format='table(name,network.basename(),direction,sourceRanges.list(),allowed[].map().firewall_rule().list(),denied[].map().firewall_rule().list(),priority)'` → only `fildi-allow-ssh tcp:22` + `fildi-deny-all-ingress all` on fildi-vpc (default network rules, if any, are on a network with no VM)
- [ ] Budget: `gcloud billing budgets list --billing-account=<ID> --billing-project=<project>` → `fildi-1usd-alert`, 1 USD, monthly; Jamie confirms the Billing console shows it + his email under Budgets & alerts
- [ ] Bootstrap: `gcloud compute instances get-serial-port-output fildi-public-1 --zone=us-west1-b | grep 'fildi bootstrap'` → `=== fildi bootstrap OK`
- [ ] From outside (Mac or box): `nc -vz -w5 <ip> 5432` → fails/timeout; `nc -vz -w5 <ip> 22` → open
- [ ] Password SSH refused: `ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password <user>@<ip>` → `Permission denied (publickey)`
- [ ] On VM (`gcloud compute ssh fildi-public-1 --zone=us-west1-b`):
  - [ ] `sudo ss -ltnp | grep 5432` → only `127.0.0.1:5432` / `[::1]:5432`
  - [ ] `sudo sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) '` → all `no`
  - [ ] `sudo ufw status verbose` → active, deny incoming, only 22/tcp allowed
  - [ ] `free -h` → Swap ~2.0Gi; `cat /proc/sys/vm/swappiness` → 10
  - [ ] `systemctl is-enabled unattended-upgrades` → enabled; `cat /etc/apt/apt.conf.d/20auto-upgrades` → both "1"
  - [ ] `sudo fail2ban-client status sshd` → jail running
  - [ ] `psql -V`, `sudo -u postgres psql -tAc 'show server_version; show listen_addresses; show shared_buffers; show max_connections'` → major = Mac's (TODO P0), `localhost`, `128MB`, `20`
  - [ ] `sudo stat -c '%a %U:%G' /etc/fildi/env` → `600 fildi:fildi`; `sudo grep -c '=.\+' /etc/fildi/env` → 1 (only FILDI_HOST_ROLE=public has a value)
  - [ ] `id fildi` → system user, shell nologin; `sudo -u postgres psql -l` → empty `tradedash` owned by fildi, no tables
  - [ ] `sudo -u postgres psql -d tradedash -tAc "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')"` → 0 (no data copied yet; P2 after security gate)

Re-running `bash cloudshell-setup.sh` is safe (idempotent). Change Postgres major: `PG_MAJOR=17 bash cloudshell-setup.sh`
before first run (after first boot, a major change needs a manual pg_upgradecluster; don't).
