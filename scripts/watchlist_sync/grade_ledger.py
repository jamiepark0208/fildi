"""Step 5: grade every Model List recommendation and attribute *why* it was good or bad (append-only).

Option ideas (sell_puts / sell_calls / review) are graded at expiry from the real close:
  P&L/share = realistic fill (L2, Robinhood) − intrinsic at expiry; return on collateral = P&L / strike (puts) or / spot (calls).
Verdict folders (own / income / avoid / holdings / watch) are graded on 5/10/21-trading-day forward return vs SPY and vs peers.

Attribution buckets (PLAN.md): market · event · data · factor · luck.
  data    the input was wrong at the time (L1/L2 data checks warned, or plan spot drifted > 3% from live). Routed to the data lane;
          never used to retune weights.
  event   earnings fell inside the window and the move was a gap (> 2× the IV-implied daily move).
  market  the market (SPY) explains most of the move: |idiosyncratic| < |market| and same sign.
  luck    the loss stayed within the range the option price implied (within 1σ of the IV-implied move): right setup, bad draw.
  factor  everything else: the model's components pointed the wrong way. Only these (plus catchable events) feed Step 6.
Graded rows also keep the losing/winning side so "good" picks are explained the same way.

Usage: .venv/bin/python grade_ledger.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import math
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from datetime import date

from build_plan import connect, rows

DDL = """
CREATE TABLE IF NOT EXISTS watchlist_sync.grades (
  id           bigserial PRIMARY KEY,
  run_id       bigint NOT NULL REFERENCES watchlist_sync.model_runs(id),
  folder_key   text NOT NULL,
  ticker       text NOT NULL,
  horizon      text NOT NULL,              -- expiry | 5d | 10d | 21d
  outcome      text NOT NULL,              -- good | bad | flat
  ret          double precision,           -- trade return on collateral (options) or stock return (verdicts)
  vs_spy       double precision,
  vs_peers     double precision,
  bucket       text NOT NULL,              -- market | event | data | factor | luck | n/a
  detail       jsonb,
  graded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, folder_key, ticker, horizon)
)"""
OPTION_FOLDERS = {"sell_puts", "sell_calls", "review"}
VERDICT_FOLDERS = {"own": 1, "income": 1, "holdings": 1, "watch": 0, "avoid": -1}  # expected sign of vs-peers return
HORIZONS = {"5d": 5, "10d": 10, "21d": 21}


def series(conn):
    px = defaultdict(list)
    for r in rows(conn, "SELECT ticker, date, close::float8 c FROM prices_historical WHERE date >= CURRENT_DATE - 400 ORDER BY ticker, date"):
        px[r["ticker"]].append((r["date"], r["c"]))
    return px


def close_on_or_before(s, d):
    ds = [x for x, _ in s]
    i = bisect_right(ds, d) - 1
    return (s[i][0], s[i][1]) if i >= 0 else (None, None)


def fwd(s, d0, n):
    ds = [x for x, _ in s]
    i = bisect_left(ds, d0)
    if i >= len(ds) or i + n >= len(ds):
        return None
    return s[i + n][1] / s[i][1] - 1


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    today = date.today()
    with connect() as conn:
        conn.execute(DDL)
        px = series(conn)
        peer = {r["ticker"]: r["name"] for r in rows(conn, """SELECT t2.ticker, g.name FROM (SELECT ticker, group_id FROM peer_group_overrides UNION ALL
            SELECT DISTINCT ON (ticker) ticker, group_id FROM peer_group_members m WHERE removed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM peer_group_overrides o WHERE o.ticker = m.ticker)) t2 JOIN peer_groups g ON g.id = t2.group_id""")}
        members = defaultdict(list)
        for t, g in peer.items():
            members[g].append(t)
        er = defaultdict(list)
        for r in rows(conn, "SELECT ticker, event_date d FROM lseg_research.events WHERE event_type = 'EarningsReleases' UNION SELECT ticker, report_date FROM lseg_research.earnings_moves"):
            er[r["ticker"]].append(r["d"])
        done = {(r["run_id"], r["folder_key"], r["ticker"], r["horizon"]) for r in rows(conn, "SELECT run_id, folder_key, ticker, horizon FROM watchlist_sync.grades")}
        # one canonical run per day (the last): re-publishing during a day must not count the same picks several times
        items = rows(conn, """SELECT i.*, r.created_at::date AS run_date, r.plan_id FROM watchlist_sync.model_items i
                              JOIN watchlist_sync.model_runs r ON r.id = i.run_id
                              WHERE r.id = (SELECT MAX(r2.id) FROM watchlist_sync.model_runs r2 WHERE r2.created_at::date = r.created_at::date)""")
        live = {(r["plan_id"], r["list_key"], r["ticker"]): r for r in rows(conn, "SELECT plan_id, list_key, ticker, live, verify_checks, l1_checks FROM watchlist_sync.plan_items")}
        spy = px.get("SPY", [])
        out = []
        for it in items:
            t, f = it["ticker"], it["folder_key"]
            s = px.get(t)
            if not s:
                continue
            if f in OPTION_FOLDERS and it["contract"]:
                c = it["contract"]
                exp = date.fromisoformat(c["expiry"])
                if exp >= today or (it["run_id"], f, t, "expiry") in done:
                    continue
                d_exp, st = close_on_or_before(s, exp)
                d0, s0 = close_on_or_before(s, it["run_date"])
                if st is None or s0 is None or d_exp < exp:
                    continue  # expiry close not loaded yet
                src = live.get((it["plan_id"], "sell_puts" if f == "review" else f, t)) or {}
                fill = (src.get("live") or {}).get("realistic_fill") or c.get("premium") or 0
                K = c["strike"]
                intrinsic = max(0.0, K - st) if c["type"] == "put" else max(0.0, st - K)
                ret = (fill - intrinsic) / (K if c["type"] == "put" else s0)  # return on collateral
                premium_kept = (fill - intrinsic) / fill if fill and fill > 0 else None
                iv = (src.get("live") or {}).get("iv") or 0.4
                days = max((exp - it["run_date"]).days, 1)
                sigma_move = iv * math.sqrt(days / 365)
                risk_adj = (ret / sigma_move) if sigma_move and sigma_move > 0 else None
                move = st / s0 - 1
                spy_move = (close_on_or_before(spy, exp)[1] / close_on_or_before(spy, it["run_date"])[1] - 1) if spy else 0
                checks = (src.get("verify_checks") or []) + (src.get("l1_checks") or [])
                data_warn = [x["check"] for x in checks if not x.get("pass") and x.get("check") in ("live_spot_drift", "spot_fresh", "fildi_premium_gap", "model_spot_matches_close")]
                er_in = any(it["run_date"] < d <= exp for d in er.get(t, []))
                # Outcome: prefer risk-adjusted / premium-kept over raw win/lose (Step 4 targets).
                # Tiers: best / good / flat / bad / very_bad (still maps learn gates via good|bad|flat).
                if data_warn:
                    tier = "flat"  # do not celebrate or punish on known-bad inputs
                elif premium_kept is not None and risk_adj is not None:
                    if premium_kept >= 0.85 and risk_adj >= 0.5:
                        tier = "best"
                    elif premium_kept >= 0.5 and ret > 0:
                        tier = "good"
                    elif abs(ret) < 0.01 or (premium_kept is not None and 0 <= premium_kept < 0.5 and ret >= 0):
                        tier = "flat"
                    elif premium_kept is not None and premium_kept < -0.5:
                        tier = "very_bad"
                    else:
                        tier = "bad"
                else:
                    tier = "good" if ret > 0 else "bad"
                outcome = "good" if tier in ("best", "good") else ("flat" if tier == "flat" else "bad")
                if data_warn:
                    bucket = "data"
                elif outcome == "good":
                    bucket = "n/a"
                elif er_in and abs(move) > 2 * iv * math.sqrt(1 / 252) * math.sqrt(days):
                    bucket = "event"
                elif abs(move - spy_move) < abs(spy_move) and move * spy_move > 0:
                    bucket = "market"
                elif abs(move) <= sigma_move:
                    bucket = "luck"
                else:
                    bucket = "factor"
                out.append((it["run_id"], f, t, "expiry", outcome, ret, move - spy_move, None, bucket,
                            json.dumps({"fill": fill, "strike": K, "close_expiry": st, "spot_entry": s0, "move": move, "spy_move": spy_move,
                                        "sigma_move": sigma_move, "premium_kept": premium_kept, "risk_adj": risk_adj,
                                        "tier": tier, "earnings_in_window": er_in, "data_warnings": data_warn,
                                        "verdict": it["verdict"], "pillars": it["pillars"], "flags": it["flags"],
                                        "days": days, "expiry": c["expiry"], "engine": c.get("engine")})))
            elif f in VERDICT_FOLDERS:
                for h, n in HORIZONS.items():
                    if (it["run_id"], f, t, h) in done:
                        continue
                    r = fwd(s, it["run_date"], n)
                    if r is None:
                        continue
                    rs = fwd(spy, it["run_date"], n) if spy else None
                    pr = [fwd(px[p], it["run_date"], n) for p in members.get(peer.get(t), []) if p != t and px.get(p)]
                    pr = [x for x in pr if x is not None]
                    vp = r - sorted(pr)[len(pr) // 2] if len(pr) >= 3 else None
                    want = VERDICT_FOLDERS[f]
                    rel = vp if vp is not None else (r - rs if rs is not None else r)
                    outcome = "flat" if want == 0 else ("good" if rel * want > 0 else "bad")
                    out.append((it["run_id"], f, t, h, outcome, r, (r - rs) if rs is not None else None, vp, "n/a",
                                json.dumps({"verdict": it["verdict"], "pillars": it["pillars"], "flags": it["flags"]})))
        print(f"gradeable now: {len(out)} " + str(dict(Counter((o[1], o[3]) for o in out))))
        if out:
            print("outcomes:", dict(Counter((o[1], o[4]) for o in out)), "· buckets:", dict(Counter(o[8] for o in out if o[4] == "bad")))
        if a.dry_run or not out:
            return
        with conn.cursor() as cur:
            cur.executemany("""INSERT INTO watchlist_sync.grades (run_id, folder_key, ticker, horizon, outcome, ret, vs_spy, vs_peers, bucket, detail)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""", out)
        conn.commit()
        print(f"graded {len(out)}")


if __name__ == "__main__":
    main()
