# Needs Jamie — things only you can do. Agents add items here (## J# title, then the steps); delete the item when done.
# Shown in Settings › Agents › Ideas as NEEDS YOU cubes (click for steps).

## J1 Oracle server: create the VM + Tailscale (for cloud agents)
Why: lets cloud agents read Fildi's public market data with your Mac closed. Private data (Robinhood, LSEG, WRDS, trades) stays on the Mac.
1. On the Mac: `ssh-keygen -t ed25519` (Enter through), then `cat ~/.ssh/id_ed25519.pub` and copy it.
2. cloud.oracle.com → Compute → Instances → Create: Ubuntu 24.04, Ampere A1.Flex 4 CPU / 24 GB (Always Free), paste the key, keep the public IP. "Out of capacity" → other availability domain or retry later.
3. tailscale.com → sign up → install the Mac app → Settings › Keys → Generate auth key.
4. Paste the IP + auth key in research/inbox.md. Claude sets it up and closes all public ports.

## J3 Later: go on the unattended data-team agent (report-only week 1)
Why: nightly checks for bad data (wrong sources, missing values, stale jobs). Waits until the current study queue is done. Say "go" when ready.

## J4 Approve Stage drill-down build order
Why: click an icon to dig in, badges only when something is off.
Proposed order: 1) APIs + Jobs split per vendor/job, 2) Database split (market data / fundamentals & scores / your book / research lab / ops) with freshness badges, 3) Code Repo + GitHub, 4) Web.
Reply "approve" or change the order.
