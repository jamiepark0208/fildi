# Mac resource report — 2026-10-16T18:18Z (scripts/resource-audit.py, weekly via Maintain Sunday)

Disk: 1503.7 GB free of 1858.1 · fildi repo 3.1 GB · DB 930 MB · RAM free 72.0% · swap 2.25 GB

## Findings
- RAM: swap 2.25 GB used (free 72.0%) — top: Google Chrome 9.34 GB, Cursor 2.91 GB, Refinitiv Workspace 2.57 GB. [ask-Jamie] close/limit heavy apps before local model runs
- iCloud: fildi not in a synced folder (good); DB, venvs, model weights never sync
- iCloud: Desktop/Documents sync ON — keep model weights/exports out of them [ask-Jamie if large files land there]
- Cursor updater cache 975 MB — old update bundles, safe to clear when Cursor is closed [ask-Jamie] (~975 MB)
- pip cache 388 MB — `pip cache purge` frees most [safe, ask-Jamie]
- pnpm cache 289 MB — `pnpm store prune` frees most [safe, ask-Jamie]
- ~/Library/Caches/Google 3.2 GB (browser cache; app manages it) [info]
- DB 930 MB, research lab tables 591 MB — research-only, keep local, exclude from server dumps [info]
- node_modules 668 MB — normal; rebuildable [info]
- growth: first snapshot — MB/day appears from next weekly run

## Biggest fildi parts (MB)
- research/openjev: 787
- venv crawl: 723
- research/crawl: 723
- node_modules: 668
- research/wrds: 362
- venv wrds: 361
- research/lseg: 268
- venv lseg: 268
