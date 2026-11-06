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
from grade_weeks import expiry_week_from_detail, failed_l1_gates, iso_week

SHADOW_STRATEGY_IDS = ("put_climax_spy_oversold", "put_climax_low_ivrv")

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
OPTION_FOLDERS = {"sell_puts", "rich_puts", "sell_calls", "review"}
VERDICT_FOLDERS = {"own": 1, "income": 1, "holdings": 1, "watch": 0, "avoid": -1}  # expected sign of vs-peers return
HORIZONS = {"5d": 5, "10d": 10, "21d": 21}


def grade_option_at_expiry(
    *,
    run_id: int,
    folder_key: str,
    ticker: str,
    run_date: date,
    opt_type: str,
    strike: float,
    expiry: date,
    fill: float,
    iv: float,
    px_series,
    spy_series,
    er_dates,
    today: date,
    done: set,
    extra_detail: dict | None = None,
    verdict: str = "",
    pillars=None,
    flags=None,
) -> tuple | None:
    """Return one grades row tuple or None if not gradeable / already done."""
    if expiry >= today or (run_id, folder_key, ticker, "expiry") in done:
        return None
    s = px_series
    if not s:
        return None
    d_exp, st = close_on_or_before(s, expiry)
    d0, s0 = close_on_or_before(s, run_date)
    if st is None or s0 is None or d_exp < expiry:
        return None
    K = float(strike)
    intrinsic = max(0.0, K - st) if opt_type == "put" else max(0.0, st - K)
    ret = (fill - intrinsic) / (K if opt_type == "put" else s0)
    premium_kept = (fill - intrinsic) / fill if fill and fill > 0 else None
    days = max((expiry - run_date).days, 1)
    sigma_move = iv * math.sqrt(days / 365)
    risk_adj = (ret / sigma_move) if sigma_move and sigma_move > 0 else None
    move = st / s0 - 1
    spy_move = (close_on_or_before(spy_series, expiry)[1] / close_on_or_before(spy_series, run_date)[1] - 1) if spy_series else 0
    er_in = any(run_date < d <= expiry for d in er_dates)
    if premium_kept is not None and risk_adj is not None:
        if premium_kept >= 0.85 and risk_adj >= 0.5:
            tier = "best"
        elif premium_kept >= 0.5 and ret > 0:
            tier = "good"
        elif abs(ret) < 0.01 or (0 <= premium_kept < 0.5 and ret >= 0):
            tier = "flat"
        elif premium_kept < -0.5:
            tier = "very_bad"
        else:
            tier = "bad"
    else:
        tier = "good" if ret > 0 else "bad"
    outcome = "good" if tier in ("best", "good") else ("flat" if tier == "flat" else "bad")
    if outcome == "good":
        bucket = "n/a"
    elif er_in and abs(move) > 2 * iv * math.sqrt(1 / 252) * math.sqrt(days):
        bucket = "event"
    elif abs(move - spy_move) < abs(spy_move) and move * spy_move > 0:
        bucket = "market"
    elif abs(move) <= sigma_move:
        bucket = "luck"
    else:
        bucket = "factor"
    detail = {
        "fill": fill,
        "strike": K,
        "close_expiry": st,
        "spot_entry": s0,
        "move": move,
        "spy_move": spy_move,
        "sigma_move": sigma_move,
        "premium_kept": premium_kept,
        "risk_adj": risk_adj,
        "tier": tier,
        "earnings_in_window": er_in,
        "days": days,
        "expiry": expiry.isoformat(),
        "breach": intrinsic > 0,
    }
    if extra_detail:
        detail.update(extra_detail)
    if verdict or pillars or flags:
        detail.update({"verdict": verdict, "pillars": pillars, "flags": flags})
    return (
        run_id,
        folder_key,
        ticker,
        "expiry",
        outcome,
        ret,
        move - spy_move,
        None,
        bucket,
        json.dumps(detail),
    )


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
                iv = (src.get("live") or {}).get("iv") or c.get("iv") or 0.4
                days = max((exp - it["run_date"]).days, 1)
                sigma_move = iv * math.sqrt(days / 365)
                risk_adj = (ret / sigma_move) if sigma_move and sigma_move > 0 else None
                move = st / s0 - 1
                spy_move = (close_on_or_before(spy, exp)[1] / close_on_or_before(spy, it["run_date"])[1] - 1) if spy else 0
                checks = (src.get("verify_checks") or []) + (src.get("l1_checks") or [])
                # live_spot_drift is not a data error here: P&L uses the live fill and the real expiry close, so a stock
                # that moved between the model run and the live quote is a real outcome (11-03: it hid MRVL -4 % in the semis crash).
                data_warn = [x["check"] for x in checks if not x.get("pass") and x.get("check") in ("spot_fresh", "fildi_premium_gap", "model_spot_matches_close")]
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
                                        "days": days, "expiry": c["expiry"], "engine": c.get("engine"), "rich": c.get("rich")})))
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
        blocked = rows(
            conn,
            """SELECT pi.plan_id, pi.list_key, pi.ticker, pi.option_type, pi.strike::float8 strike, pi.expiry,
                      pi.model_premium::float8 premium, pi.model_spot::float8 spot, pi.model_iv::float8 iv, pi.l1_checks,
                      p.close_date AS run_date, mr.id AS run_id
               FROM watchlist_sync.plan_items pi
               JOIN watchlist_sync.plans p ON p.id = pi.plan_id
               JOIN LATERAL (
                 SELECT id FROM watchlist_sync.model_runs WHERE plan_id = pi.plan_id ORDER BY id DESC LIMIT 1
               ) mr ON mr.id IS NOT NULL
               WHERE NOT pi.l1_pass AND pi.kind = 'option' AND pi.expiry < %s""",
            (today,),
        )
        for bi in blocked:
            t = bi["ticker"]
            s = px.get(t)
            gates = failed_l1_gates(bi["l1_checks"])
            if not gates:
                continue
            fill = float(bi["premium"] or 0)
            if fill <= 0:
                continue
            iv = float(bi["iv"] or 0.4)
            run_date = bi["run_date"]
            exp = bi["expiry"]
            for gate in gates:
                fk = f"blocked:{gate}"
                row = grade_option_at_expiry(
                    run_id=bi["run_id"],
                    folder_key=fk,
                    ticker=t,
                    run_date=run_date,
                    opt_type=bi["option_type"] or "put",
                    strike=bi["strike"],
                    expiry=exp,
                    fill=fill,
                    iv=iv,
                    px_series=s,
                    spy_series=spy,
                    er_dates=er.get(t, []),
                    today=today,
                    done=done,
                    extra_detail={"blocked_gate": gate, "plan_id": bi["plan_id"], "list_key": bi["list_key"]},
                )
                if row:
                    out.append(row)
        sig_tbl = rows(
            conn,
            "SELECT to_regclass('watchlist_sync.strategy_signals') IS NOT NULL ok",
        )[0]["ok"]
        if sig_tbl:
            for sr in rows(
                conn,
                """SELECT strategy_id, as_of, ticker, entry_date, expiry, strike, entry_mid, ret, itm
                   FROM watchlist_sync.strategy_signals
                   WHERE status = 'graded' AND strategy_id = ANY(%s)""",
                (list(SHADOW_STRATEGY_IDS),),
            ):
                fk = f"shadow:{sr['strategy_id']}"
                run_row = rows(
                    conn,
                    """SELECT id FROM watchlist_sync.model_runs
                       WHERE created_at::date <= %s ORDER BY created_at DESC LIMIT 1""",
                    (sr["as_of"],),
                )
                if not run_row:
                    continue
                run_id = run_row[0]["id"]
                if (run_id, fk, sr["ticker"], "expiry") in done:
                    continue
                ret = float(sr["ret"] or 0)
                ed = sr["entry_date"] or sr["as_of"]
                detail = {
                    "strategy_id": sr["strategy_id"],
                    "as_of": sr["as_of"].isoformat(),
                    "entry_date": ed.isoformat() if ed else None,
                    "expiry": sr["expiry"].isoformat() if sr["expiry"] else None,
                    "strike": sr["strike"],
                    "fill": sr["entry_mid"],
                    "breach": bool(sr["itm"]),
                }
                wk = expiry_week_from_detail(detail, ed)
                if wk:
                    detail["expiry_week"] = list(wk)
                outcome = "good" if ret > 0 else ("flat" if abs(ret) < 1e-6 else "bad")
                out.append(
                    (
                        run_id,
                        fk,
                        sr["ticker"],
                        "expiry",
                        outcome,
                        ret,
                        None,
                        None,
                        "n/a",
                        json.dumps(detail),
                    )
                )
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
