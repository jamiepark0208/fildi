"""PM alerts (Claude, portfolio-manager role, user 2026-10-14). Turns pm_book's book into a few alerts that change something.

Rules (thresholds live in pm_book.PM_RULES; the user set crash_budget 25% red / 20% amber on 2026-10-14):
  status     an account's status gets worse (green → amber → red); also "back to green" once
  margin     margin headroom if this week's ITM puts are assigned < 0 (= margin call on assignment)
  desk       expiry desk: Thu 12:15 PT and Fri 06:45 PT, one digest of ITM puts expiring this week with P(OTM), close cost,
             and what assignment does to cash / margin. Information, not a call: S015 found holding vs closing EV-neutral,
             so the only reason to act is cash/margin.

Only new or worse states alert (state in out/pm/alerts-state.json); no repeats for an unchanged risk. Quiet outside 06:00–20:00 PT.
Delivery: out/pm/alerts-log.jsonl (Fildi alert center reads it) + macOS notification + email to self via the user's own Apps Script
web app (scripts/apps-script/PmAlertMail.gs) when PM_ALERT_WEBHOOK / PM_ALERT_SECRET are set in .env.local. No phone app needed.

    .venv/bin/python pm_alerts.py            # re-price live (Schwab), rebuild the book, send what changed
    .venv/bin/python pm_alerts.py --dry      # print, send nothing, keep state
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
OUT = HERE / "out" / "pm"
STATE = OUT / "alerts-state.json"
LOG = OUT / "alerts-log.jsonl"
PT = ZoneInfo("America/Los_Angeles")
RANK = {"green": 0, "amber": 1, "red": 2}
f = lambda v: f"${v:,.0f}"  # noqa: E731


def env(name: str) -> str | None:
    if os.environ.get(name):
        return os.environ[name]
    p = HERE.parents[1] / ".env.local"
    for line in p.read_text().splitlines() if p.exists() else []:
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def build_book() -> dict:
    subprocess.run([sys.executable, str(HERE / "pm_book.py"), "--live"], cwd=HERE, check=True, capture_output=True)
    return json.loads((OUT / "book-latest.json").read_text())


def desk_slot(now: datetime) -> str | None:
    if now.weekday() == 3 and (now.hour, now.minute) >= (12, 15):
        return "thu"
    if now.weekday() == 4 and (now.hour, now.minute) >= (6, 45):
        return "fri"
    return None


def evaluate(book: dict, state: dict, now: datetime) -> list[dict]:
    alerts = []
    for name, b in book["accounts"].items():
        prev = state.get(f"status:{name}", "green")
        if RANK[b["status"]] > RANK[prev] or (b["status"] == "green" and prev != "green"):
            why = [f"crash week (−30%) → equity {f(b['crash_equity'])} ({b['crash_drop_pct']:.0%} drop vs {book['rules']['crash_budget']:.0%} budget)"]
            if "headroom_if_assigned" in b:
                why.append(f"margin headroom if ITM puts assign {f(b['headroom_if_assigned'])}")
            alerts.append({"key": f"status:{name}", "level": b["status"], "title": f"{name} book {b['status'].upper()}", "body": " · ".join(why)})
        state[f"status:{name}"] = b["status"]
        if "headroom_if_assigned" in b:
            call = b["headroom_if_assigned"] < 0
            if call and not state.get(f"margin:{name}"):
                alerts.append({"key": f"margin:{name}", "level": "red", "title": f"{name}: assignment = margin call",
                               "body": f"{b['itm_puts']} ITM puts need {f(b['assign_if_itm_now'])}; headroom after {f(b['headroom_if_assigned'])}. "
                                       f"Closing the ITM puts costs {f(b['close_itm_cost'])}."})
            state[f"margin:{name}"] = call
    slot = desk_slot(now)
    key = f"desk:{now.date()}:{slot}"
    if slot and not state.get(key):
        week = [p for p in book["positions"] if p["itm"] and p["days_left"] <= 2]
        if week:
            lines = [f"{p['account']} {p['ticker']} {p['strike']:g}P · spot {p['spot']:.2f} needs {p['move_needed']:+.0%} · "
                     f"P(OTM) {p['p_otm']:.0%} · close {f(p['close_cost'])} · assign {f(p['assign_cash'])}" for p in week if p["p_otm"] is not None]
            for name, b in book["accounts"].items():
                if "headroom_if_assigned" in b:
                    lines.append(f"{name} margin headroom if assigned {f(b['headroom_if_assigned'])}")
                else:
                    lines.append(f"{name} cash {f(b['cash'])} vs assignment {f(b['assign_if_itm_now'])}")
            alerts.append({"key": key, "level": "amber", "title": f"Expiry desk ({slot}): {len(week)} ITM puts", "body": "\n".join(lines)})
        state[key] = True
    return alerts


def deliver(a: dict) -> None:
    subprocess.run(["osascript", "-e", f'display notification {json.dumps(a["body"][:200])} with title {json.dumps("Fildi PM — " + a["title"])}'],
                   capture_output=True)
    url, secret = env("PM_ALERT_WEBHOOK"), env("PM_ALERT_SECRET")
    if url and secret:
        body = json.dumps({"secret": secret, "subject": f"[Fildi PM] {a['title']}", "body": a["body"]}).encode()
        try:
            urllib.request.urlopen(urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}), timeout=30)
            a["emailed"] = True
        except Exception as e:  # noqa: BLE001
            a["email_error"] = str(e)[:120]


def main() -> None:
    dry = "--dry" in sys.argv
    now = datetime.now(PT)
    if not dry and (now.weekday() > 4 or not 6 <= now.hour < 20):
        return
    book = build_book()
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    alerts = evaluate(book, state, now)
    for a in alerts:
        a["at"] = now.isoformat(timespec="seconds")
        a["priced_at"] = book.get("live_priced_at") or book["snapshot_at"]
        if dry:
            print(f"[{a['level']}] {a['title']}\n  {a['body']}")
            continue
        deliver(a)
        with LOG.open("a") as fh:
            fh.write(json.dumps(a) + "\n")
    if not dry:
        STATE.write_text(json.dumps(state, indent=1))


if __name__ == "__main__":
    main()
