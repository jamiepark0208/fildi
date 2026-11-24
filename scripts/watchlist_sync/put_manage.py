#!/usr/bin/env python3
"""Open sold-put management (A279 / S103, Jamie 10-26: "close at a win when the daily rate is far above plan and re-sell").

Per open short put (latest portfolio snapshot): captured = (entry credit − buy-back at ask − 23 % of the spread) ÷ credit;
pace = captured per elapsed day ÷ (1 ÷ days entry→expiry). Rules from S103 on real LSEG quotes:
  take + re-sell  weekly (≤ 10 days entry→expiry), captured ≥ 25 % and pace ≥ 4× (+0.018…0.021 % of strike per trade vs
                  holding, ≈ +25 %, t ≈ 1 — positive in model and real quotes, never worse) → next engine pick to re-sell
  hold            everything else; puts of 2+ weeks: every early exit lost on real quotes (t −2…−4)
  never stop on a trend flip  UT Bot / SuperTrend-cluster stops lost (t −1.8…−3.7; S017 same) — shown as a note only

    .venv/bin/python put_manage.py            # → watchlist_sync.put_manage_daily + printout
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from math import erf, log, sqrt

from build_plan import connect

CHAIN_URL = "http://127.0.0.1:8080/api/schwab/chain-ladder"
ROLL_LINK_WINDOW = timedelta(minutes=10)
MAX_CHAIN = 15            # A392: ≤ 15 chain calls per run (one per ticker, worst loss first)
ROLL_DTE = (5, 45)        # roll expiries: 5–45 days past the current one
SPREAD_BUY, SPREAD_SELL = 0.23, 0.10   # buy-back at ask − 23 % of spread (as `captured`); sell at bid + 10 % of spread


@dataclass(frozen=True)
class Fill:
    account: str
    symbol: str
    strike: float
    expiry: date
    effect: str
    side: str
    ts: datetime
    qty: float
    price: float
    order_id: str


@dataclass
class PriorRollResult:
    prior_per_share: float
    prior_total_usd: float
    roll_hops: int
    roll_note: str | None


def _contract_key(f: Fill) -> tuple[str, str, float, date]:
    return (f.account, f.symbol, f.strike, f.expiry)


def _position_open_fill(
    fills: list[Fill], account: str, symbol: str, strike: float, expiry: date
) -> Fill | None:
    key = (account, symbol, strike, expiry)
    ev = sorted((f for f in fills if _contract_key(f) == key), key=lambda x: x.ts)
    last_close = max((f.ts for f in ev if f.effect == "close"), default=None)
    opens = [
        f
        for f in ev
        if f.effect == "open" and f.side == "sell" and (last_close is None or f.ts > last_close)
    ]
    if opens:
        return min(opens, key=lambda x: x.ts)
    opens = [f for f in ev if f.effect == "open" and f.side == "sell"]
    return max(opens, key=lambda x: x.ts) if opens else None


def _match_close_before_open(
    fills: list[Fill], account: str, symbol: str, open_fill: Fill, used: set[str] | None = None
) -> Fill | None:
    cands = []
    for f in fills:
        if f.account != account or f.symbol != symbol:
            continue
        if f.effect != "close" or f.side != "buy":
            continue
        if used is not None and f.order_id in used:
            continue
        if open_fill.expiry < f.expiry:
            continue
        if open_fill.qty > f.qty + 1e-9:
            continue
        dt = open_fill.ts - f.ts
        if timedelta(0) <= dt <= ROLL_LINK_WINDOW:
            cands.append((dt, f))
    return min(cands, key=lambda x: x[0])[1] if cands else None


def _open_before_close(fills: list[Fill], close: Fill) -> Fill | None:
    key = _contract_key(close)
    opens = [
        f
        for f in fills
        if _contract_key(f) == key and f.effect == "open" and f.side == "sell" and f.ts < close.ts
    ]
    return max(opens, key=lambda x: x.ts) if opens else None


def _same_day_unlinked_note(fills: list[Fill], account: str, symbol: str, open_fill: Fill) -> str | None:
    od = open_fill.ts.date()
    for f in fills:
        if f.account != account or f.symbol != symbol:
            continue
        if f.effect != "close" or f.side != "buy":
            continue
        if f.ts.date() != od:
            continue
        dt = open_fill.ts - f.ts
        if ROLL_LINK_WINDOW < dt < timedelta(hours=24):
            return f"possible roll on {od.isoformat()} not counted"
    return None


def compute_prior_roll_credits(
    fills: list[Fill],
    account: str,
    symbol: str,
    strike: float,
    expiry: date,
    qty: float,
    used: set[str] | None = None,
) -> PriorRollResult:
    if qty <= 0:
        return PriorRollResult(0.0, 0.0, 0, None)
    open_cur = _position_open_fill(fills, account, symbol, strike, expiry)
    if open_cur is None:
        return PriorRollResult(0.0, 0.0, 0, "roll credits unknown")
    note: str | None = None
    hops = 0
    prior_ps = 0.0
    walk_open = open_cur
    while True:
        close_a = _match_close_before_open(fills, account, symbol, walk_open, used)
        if close_a is None:
            unlinked = _same_day_unlinked_note(fills, account, symbol, walk_open)
            if unlinked and hops == 0 and prior_ps == 0:
                note = unlinked
            break
        if used is not None:
            used.add(close_a.order_id)
        open_a = _open_before_close(fills, close_a)
        if open_a is None:
            return PriorRollResult(0.0, 0.0, hops, "roll credits unknown")
        match_qty = min(close_a.qty, walk_open.qty)
        prior_ps += (open_a.price - close_a.price) * (match_qty / walk_open.qty)
        hops += 1
        walk_open = open_a
    return PriorRollResult(
        prior_per_share=round(prior_ps, 4),
        prior_total_usd=round(prior_ps * qty * 100, 2),
        roll_hops=hops,
        roll_note=note,
    )


def chain(t: str, frm: date, to: date) -> dict | None:
    """Same Schwab chain-ladder call as s172_paper.chain(), 60 s deadline."""
    req = urllib.request.Request(CHAIN_URL, headers={"Content-Type": "application/json"},
                                 data=json.dumps({"ticker": t, "fromDate": str(frm), "toDate": str(to), "strikeCount": 60}).encode())
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except Exception as e:  # noqa: BLE001
        print(f"  {t}: chain fetch failed: {type(e).__name__}: {e}")
        return None


def _ncdf(x: float) -> float:
    return 0.5 * (1 + erf(x / sqrt(2)))


def p_itm(spot: float, k: float, iv: float | None, days: int) -> float | None:
    """Black-Scholes P(S_T < K), r=0, no dividends."""
    if not iv or iv <= 0 or days <= 0 or spot <= 0:
        return None
    t = days / 365
    d2 = (log(spot / k) - 0.5 * iv * iv * t) / (iv * sqrt(t))
    return _ncdf(-d2)


def _leg(spot: float, k: float, iv, days: int, basis: float, net: float | None = None) -> dict:
    pi = p_itm(spot, k, iv, days)
    return {"p_itm": None if pi is None else round(100 * pi, 1), "p_touch": None if pi is None else round(100 * min(1.0, 2 * pi), 1)}


def build_options(
    strike: float,
    expiry: date,
    qty: float,
    credit: float,
    buy: float,
    ch: dict | None,
    band: str | None,
    today: date,
    prior_roll_ps: float = 0.0,
    prior_roll_total: float = 0.0,
    roll_hops: int = 0,
    roll_note: str | None = None,
) -> dict:
    """hold / close / assign / rolls for one open short put. Per-share dollars unless `_usd` (× 100 × qty)."""
    usd = 100 * qty
    out: dict = {
        "close": {"pnl_usd": round((credit - buy) * usd, 2), "buy_back": round(buy, 4)},
        "prior_roll_credit": round(prior_roll_ps, 4),
        "prior_roll_credit_usd": prior_roll_total,
        "roll_hops": roll_hops,
    }
    if roll_note:
        out["roll_note"] = roll_note
    spot = (ch or {}).get("spot")
    rows = [r for r in (ch or {}).get("rows", []) if r.get("side") == "put"]
    dte_cur = max((expiry - today).days, 0)
    cur = next((r for r in rows if r["expiry"] == str(expiry) and abs(r["strike"] - strike) < 1e-6), None)
    out["spot"] = spot
    if spot:
        total_cr = credit + (prior_roll_ps if roll_note != "roll credits unknown" else 0.0)
        hold_be = strike - total_cr
        assign_basis = hold_be
        out["assign"] = {
            "basis": round(assign_basis, 4),
            "spot": spot,
            "vs_spot_pct": round(100 * (spot / assign_basis - 1), 1),
            "loss_usd": round(min(spot - assign_basis, 0) * usd, 2),
        }
        out["hold"] = {
            "pnl_usd": round((credit - buy) * usd, 2),
            "breakeven": round(hold_be, 4),
            **_leg(spot, strike, cur and cur.get("iv"), dte_cur, hold_be),
        }
    if not rows or not spot:
        out["rolls"] = []
        out["rolls_note"] = "no chain" if ch is None else "chain empty"
        return out
    lo, hi = expiry + timedelta(days=ROLL_DTE[0]), expiry + timedelta(days=ROLL_DTE[1])
    cands = []
    for r in rows:
        e = date.fromisoformat(r["expiry"])
        if not (lo <= e <= hi) or r["strike"] > strike + 1e-6 or not r.get("bid") or r["bid"] <= 0 or r.get("ask") is None:
            continue
        sell = r["bid"] + SPREAD_SELL * (r["ask"] - r["bid"])
        net = sell - buy
        dte = (e - today).days
        extra = (e - expiry).days
        total_cr = credit + (prior_roll_ps if roll_note != "roll credits unknown" else 0.0)
        basis = r["strike"] - (total_cr + net)
        cands.append({"strike": r["strike"], "expiry": r["expiry"], "dte": dte, "extra_days": extra, "sell": round(sell, 4),
                      "net": round(net, 4), "net_usd": round(net * usd, 2), "breakeven": round(basis, 4), "delta": r.get("delta"),
                      "ann_pct": round(100 * net / r["strike"] * 365 / extra, 1) if extra > 0 else None,
                      **_leg(spot, r["strike"], r.get("iv"), dte, basis)})
    exps = sorted({c["expiry"] for c in cands})
    picked: list[dict] = []

    def add(kind: str, c: dict | None):
        if c and not any(p["strike"] == c["strike"] and p["expiry"] == c["expiry"] for p in picked):
            picked.append({"kind": kind, **c})

    same = [c for c in cands if c["expiry"] in exps[:2]]
    for e in exps[:2]:   # (a) roll out: highest listed strike ≤ current, next 1–2 expiries
        near = [c for c in same if c["expiry"] == e]
        add("out", max(near, key=lambda c: c["strike"]) if near else None)
    dn = [c for c in same if c["net"] >= 0 and c["strike"] < strike - 1e-6]   # (b) lowest strike still paying a net credit
    add("down", min(dn, key=lambda c: (c["strike"], c["expiry"])) if dn else None)
    if band and exps:   # (c) nearest engine band_target delta, first roll expiry
        try:
            a, b = (float(x) for x in band.split("-"))
            near = [c for c in cands if c["expiry"] == exps[0] and c["delta"] is not None]
            add("band", min(near, key=lambda c: abs(abs(c["delta"]) - (a + b) / 2)) if near else None)
        except ValueError:
            pass
    out["rolls"] = picked[:4]
    if not picked:
        out["rolls_note"] = "no roll candidate (strike ≤ current, 5–45 d past expiry, bid > 0)"
    return out

PACE, MIN_CAP, WEEKLY_DAYS = 4.0, 0.25, 10


def decide(credit: float, bid: float, ask: float, el: int, tot: int, weekly: bool) -> tuple[float, float, float, bool]:
    """buy-back at ask − 23 % of spread → captured share, pace vs plan, take rule (S103)."""
    buy = max(ask - SPREAD_BUY * (ask - bid), 0.0)
    cap = (credit - buy) / credit
    pace = (cap / el) / (1 / tot)
    return buy, cap, pace, weekly and cap >= MIN_CAP and pace >= PACE


def main():
    today = date.today()
    with connect() as conn:
        snap = conn.execute("SELECT MAX(id) FROM portfolio_snapshots").fetchone()[0]
        pos = conn.execute("""SELECT coalesce(account, ''), symbol, strike::float8, expiration, qty::float8, avg_premium::float8,
                                     bid::float8, ask::float8
                              FROM portfolio_options WHERE snapshot_id = %s AND direction = 'short' AND option_type ILIKE 'put%%'""",
                           (snap,)).fetchall()
        # A372: entry = first sell-to-open fill after the contract's last buy-to-close (per account); first snapshot only as fallback
        first_seen = dict(((a, s, k, e), d) for a, s, k, e, d in conn.execute(
            """SELECT coalesce(o.account, ''), o.symbol, o.strike::float8, o.expiration, MIN(p.imported_at)::date FROM portfolio_options o
               JOIN portfolio_snapshots p ON p.id = o.snapshot_id WHERE o.direction = 'short' AND o.option_type ILIKE 'put%%'
               GROUP BY 1, 2, 3, 4"""))
        fills: dict = {}
        all_fills: list[Fill] = []
        for a, s, k, e, eff, side, ts, qty, px, oid in conn.execute(
            """SELECT DISTINCT ON (coalesce(order_id, id::text)) coalesce(account, ''), symbol, option_strike::float8, option_expiration,
                      leg_effect, leg_side, coalesce(last_transaction_at, created_at),
                      quantity::float8, avg_fill_price::float8, coalesce(order_id, id::text)
               FROM portfolio_orders WHERE is_option AND option_side ILIKE 'put%%' AND state = 'filled'
                 AND ((leg_side = 'sell' AND leg_effect = 'open') OR (leg_side = 'buy' AND leg_effect = 'close'))
               ORDER BY coalesce(order_id, id::text), snapshot_id DESC"""):
            if ts is not None:
                fills.setdefault((a, s, k, e), []).append((ts, eff))
                if px is not None and px > 0:
                    all_fills.append(
                        Fill(a, s, k, e, eff, side, ts, qty or 0.0, float(px), oid)
                    )
        def opened_on(key):
            ev = sorted(fills.get(key, []))
            last_close = max((t for t, eff in ev if eff == "close"), default=None)
            opens = [t for t, eff in ev if eff == "open" and (last_close is None or t > last_close)]
            if opens:
                return min(opens).date(), "fill"
            return first_seen.get(key, today), "first snapshot"
        tech = dict(conn.execute("""SELECT DISTINCT ON (ticker) ticker, payload FROM watchlist_sync.indicators_daily
                                    ORDER BY ticker, as_of DESC""").fetchall()) if conn.execute(
            "SELECT to_regclass('watchlist_sync.indicators_daily')").fetchone()[0] else {}
        held = {p[0] for p in pos}
        nxt = [r for (r,) in conn.execute("""SELECT payload FROM watchlist_sync.put_recs_daily
                                             WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) AND pass ORDER BY rank""")
               if r["ticker"] not in held][:3]
        band = {}
        for tkr, bt in conn.execute("""SELECT DISTINCT ON (payload->>'ticker') payload->>'ticker', payload->>'band_target'
                                        FROM watchlist_sync.put_recs_daily ORDER BY payload->>'ticker', as_of DESC"""):
            band[tkr] = bt
        out = []
        agg = {}
        for acct, s, k, e, q, prem, b, a in pos:   # merge lots of the same contract inside one account (weighted credit)
            g = agg.setdefault((acct, s, k, e), [0.0, 0.0, b, a])
            g[0] += q; g[1] += q * prem
        for (acct, s, k, e), (q, tot_prem, b, a) in agg.items():
            credit = tot_prem / q / 100
            if credit <= 0 or a is None or b is None:
                continue
            od, od_src = opened_on((acct, s, k, e))
            el, tot = max((today - od).days, 1), max((e - od).days, 1)
            weekly = tot <= WEEKLY_DAYS
            buy, cap, pace, take = decide(credit, b, a, el, tot, weekly)
            t = tech.get(s) or {}
            note = []
            if t.get("ut_dir") == -1 or (t.get("stc_bull") is not None and t["stc_bull"] <= 0.4):
                note.append("trend turned down — not a reason to close (S103: trend stops lost)")
            r = {"account": acct, "snapshot_id": snap, "opened_src": od_src, "quote_src": "snapshot", "ticker": s, "strike": k, "expiry": str(e), "qty": q, "opened": str(od), "credit": round(credit, 4), "buy_back": round(buy, 4),
                 "captured_pct": round(100 * cap, 1), "pace": round(pace, 2), "days_held": el, "days_total": tot,
                 "action": "take + re-sell" if take else "hold",
                 "why": (f"captured {100 * cap:.0f} % in {el} of {tot} days = {pace:.1f}× plan pace ≥ {PACE:g}× (S103)" if take else
                         f"{100 * cap:.0f} % captured, {pace:.1f}× pace" + ("" if weekly else " · 2+ week put: hold (S103: early exits lost)")),
                 "notes": note, "resell": [{"ticker": n["ticker"], "strike": n["strike"], "expiry": n["expiry"], "income_wk_pct": n["income_wk_pct"]}
                                           for n in nxt] if take else []}
            r["_q"] = q
            r["_bidask"] = (b, a)
            out.append(r)
        # A392: roll/defend options — one chain call per ticker, worst loss first, capped
        t0, calls = time.time(), 0
        loss = {}
        for r in out:
            loss[r["ticker"]] = loss.get(r["ticker"], 0.0) + (r["buy_back"] - r["credit"]) * r["_q"]
        chains = {}
        for tkr in sorted(loss, key=lambda x: -loss[x])[:MAX_CHAIN]:
            exps = [date.fromisoformat(r["expiry"]) for r in out if r["ticker"] == tkr]
            chains[tkr] = chain(tkr, max(min(exps), today), max(exps) + timedelta(days=ROLL_DTE[1]))
            calls += 1
        used_closes: set[str] = set()

        def _open_fill_ts(r: dict) -> datetime:
            exp = date.fromisoformat(r["expiry"])
            o = _position_open_fill(all_fills, r["account"], r["ticker"], r["strike"], exp)
            return o.ts if o else datetime.max

        roll_cache: dict[tuple[str, str, float, str], PriorRollResult] = {}
        for r in sorted(out, key=_open_fill_ts):
            exp = date.fromisoformat(r["expiry"])
            roll_cache[(r["account"], r["ticker"], r["strike"], r["expiry"])] = compute_prior_roll_credits(
                all_fills, r["account"], r["ticker"], r["strike"], exp, r["_q"], used=used_closes
            )
        for r in out:
            q = r.pop("_q")
            r.pop("_bidask", None)
            ch = chains.get(r["ticker"])
            cur = next((c for c in (ch or {}).get("rows", []) if c.get("side") == "put" and c.get("expiry") == r["expiry"]
                        and abs(c.get("strike", -1) - r["strike"]) < 1e-6 and c.get("bid") is not None and c.get("ask")), None)
            if cur:   # A372: price the headline action on the fresh chain quote, not the snapshot's bid/ask
                buy, cap, pace, take = decide(r["credit"], cur["bid"], cur["ask"], r["days_held"], r["days_total"],
                                              r["days_total"] <= WEEKLY_DAYS)
                r.update(buy_back=round(buy, 4), captured_pct=round(100 * cap, 1), pace=round(pace, 2), quote_src="chain",
                         action="take + re-sell" if take else "hold",
                         why=(f"captured {100 * cap:.0f} % in {r['days_held']} of {r['days_total']} days = {pace:.1f}× plan pace ≥ {PACE:g}× (S103)"
                              if take else f"{100 * cap:.0f} % captured, {pace:.1f}× pace"
                              + ("" if r["days_total"] <= WEEKLY_DAYS else " · 2+ week put: hold (S103: early exits lost)")),
                         resell=[{"ticker": n["ticker"], "strike": n["strike"], "expiry": n["expiry"], "income_wk_pct": n["income_wk_pct"]}
                                 for n in nxt] if take else [])
            exp = date.fromisoformat(r["expiry"])
            roll = roll_cache[(r["account"], r["ticker"], r["strike"], r["expiry"])]
            bo_kw = dict(
                prior_roll_ps=roll.prior_per_share,
                prior_roll_total=roll.prior_total_usd,
                roll_hops=roll.roll_hops,
                roll_note=roll.roll_note,
            )
            if r["ticker"] in chains:
                r.update(
                    build_options(
                        r["strike"], exp, q, r["credit"], r["buy_back"],
                        chains[r["ticker"]], band.get(r["ticker"]), today, **bo_kw
                    )
                )
            else:
                r.update(build_options(r["strike"], exp, q, r["credit"], r["buy_back"], None, None, today, **bo_kw))
                r["rolls_note"] = "over 15-chain cap"
        print(f"roll analysis: {calls} chain calls, {time.time() - t0:.1f}s")
        conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.put_manage_daily (as_of date, account text NOT NULL DEFAULT '', ticker text,
                        strike float8, expiry date, payload jsonb, computed_at timestamptz DEFAULT now(),
                        PRIMARY KEY (as_of, account, ticker, strike, expiry))""")
        conn.execute("ALTER TABLE watchlist_sync.put_manage_daily ADD COLUMN IF NOT EXISTS account text NOT NULL DEFAULT ''")
        pk = conn.execute("""SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_index i JOIN pg_attribute a
                             ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                             WHERE i.indrelid = 'watchlist_sync.put_manage_daily'::regclass AND i.indisprimary""").fetchone()[0] or []
        if "account" not in pk:   # A372 migration: one row per account × contract
            conn.execute("ALTER TABLE watchlist_sync.put_manage_daily DROP CONSTRAINT IF EXISTS put_manage_daily_pkey")
            conn.execute("ALTER TABLE watchlist_sync.put_manage_daily ADD PRIMARY KEY (as_of, account, ticker, strike, expiry)")
        conn.execute("DELETE FROM watchlist_sync.put_manage_daily WHERE as_of = %s", (today,))
        for r in out:
            conn.execute("INSERT INTO watchlist_sync.put_manage_daily (as_of, account, ticker, strike, expiry, payload) VALUES (%s,%s,%s,%s,%s,%s)",
                         (today, r["account"], r["ticker"], r["strike"], r["expiry"], json.dumps(r)))
        conn.commit()
    for r in sorted(out, key=lambda r: r["action"] != "take + re-sell"):
        print(f"{r['action']:14s} {r['ticker']:6s} {r['strike']:g}p {r['expiry']} ×{r['qty']:g}: {r['why']}"
              + (f" → re-sell {r['resell'][0]['ticker']} {r['resell'][0]['strike']:g}p" if r["resell"] else "")
              + (f" [{'; '.join(r['notes'])}]" if r["notes"] else ""))
    for r in out:
        rl = "; ".join(f"{c['kind']} {c['strike']:g}p {c['expiry'][5:]} net {c['net']:+.2f} P(ITM) {c['p_itm']}%" for c in r.get("rolls", []))
        print(f"  {r['ticker']:6s} {r['strike']:g}p {r['expiry']}: " + (rl or f"no rolls ({r.get('rolls_note')})"))
    print(f"put manage: {len(out)} open short puts, {sum(r['action'] != 'hold' for r in out)} to take → watchlist_sync.put_manage_daily")


if __name__ == "__main__":
    main()
