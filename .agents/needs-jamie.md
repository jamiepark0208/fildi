# Needs Jamie — things only you can do. Agents add items here (## J# title, then the steps); delete the item when done.
# Only items that need Jamie to act or decide. Info-only notes go in state/ASKS, never here. Jamie's Dismiss → the idea's ASKS row becomes `declined (Jamie dismissed <date>)` → shows under Parked.
# Shown in Settings › Agents › Ideas as NEEDS YOU cubes (click for steps).


## J3 Later: go on the unattended data-team agent (report-only week 1)
Why: nightly checks for bad data (wrong sources, missing values, stale jobs). Waits until the current study queue is done. Say "go" when ready.


## J5 Auto-reply to your comments? (opt-in)
Why: today Claude only sees your comments the next time you message it.
Option: a tiny local auto-responder. When you post, it runs a cheap model (Haiku, read-only, no edits) with only that item's text + thread and replies within ~1 min.
Cost ≈ 2–5k tokens per comment, nothing when idle.
Reply yes/no in this thread.

## J6 Cloud agents without a server: pick an option
Why: lets Claude routines (cloud) review scores/data with your Mac closed. Recommended: (A) nightly the Mac exports a small read-only snapshot of PUBLIC data only (scores, fair value, Model List, 1 y prices, study outputs) as compressed files to a private GitHub repo; cloud agents read it, file findings back via git. $0, no server, no secrets in the cloud, data ≤1 day old.
Other: (B) same snapshot into a free hosted Postgres (Neon, 0.5 GB) — SQL access but a password in the cloud; (C) keep agents on the Mac (works only while it is on).
Reply A, B or C.

## J7 Fildi on your phone (Tailscale, Mac stays the server)
Why: open Fildi from your phone anywhere, private (only your devices), free. Works while the Mac is on and awake.
1. Install Tailscale on the Mac (tailscale.com/download) and on your phone (App Store), sign in with the same account on both.
2. Reply "done" here. Claude makes Fildi reachable on your private Tailscale address and sends you the link.


## J9 Optional: let the Mac wake itself for the 5:30 AM OpenJev run
Why: the local forecast run happens 5:30–9:00 AM when RAM is free. If the Mac is asleep it runs at next wake (or the 9–11:30 PM window), so this is optional.
1. In Terminal: `sudo pmset repeat wakeorpoweron MTWRFSU 05:25:00` (wakes only; runs only when on the charger).
2. Undo anytime: `sudo pmset repeat cancel`.
3. Reply "done" or "skip".
