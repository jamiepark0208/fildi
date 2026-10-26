"""One Polygon budget for every Python caller (option_history, intraday_1m_backfill, studies).

Free plan = 5 calls/min shared by ALL processes, so the per-script timers each fetcher used to keep could collide → 429s.
`wait()` takes an exclusive file lock, sleeps until GAP_S after the last call made by ANY process, stamps the time and
releases. `record(conn, n)` adds n to api_usage (Settings › API Monitor). Node's polygon-limiter.ts takes this same flock (A267).
"""
from __future__ import annotations

import fcntl
import time
from pathlib import Path

GAP_S = 12.5  # 4.8 calls/min, under the 5/min cap
GATE = Path("/tmp/fildi-logs/polygon.gate")


def wait() -> None:
    # Reserve the next slot under the lock, sleep after releasing it (10-26: sleeping inside the flock starved other
    # callers into polygon-limiter.ts's lock timeout). The stamp is the reserved slot, same as the Node side.
    GATE.parent.mkdir(parents=True, exist_ok=True)
    with open(GATE, "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        try:
            last = float(f.read().strip() or 0)
        except ValueError:
            last = 0.0
        now = time.time()
        slot = max(now, last + GAP_S)
        f.seek(0)
        f.truncate()
        f.write(str(slot))
        f.flush()
    if slot > now:
        time.sleep(slot - now)


def record(conn, n: int) -> None:
    if not n:
        return
    conn.execute("""INSERT INTO api_usage (source, date, calls_made, updated_at)
                    VALUES ('polygon', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s, now())
                    ON CONFLICT (source, date) DO UPDATE SET calls_made = api_usage.calls_made + excluded.calls_made,
                    updated_at = now()""", (n,))
    conn.commit()
