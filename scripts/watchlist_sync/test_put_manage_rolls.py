"""A417: roll-chain credit for put_manage assign basis (pure functions, no DB)."""
from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from put_manage import Fill, build_options, compute_prior_roll_credits

ROLL_WIN = timedelta(minutes=10)


def _f(
    account: str,
    symbol: str,
    strike: float,
    expiry: date,
    effect: str,
    side: str,
    ts: datetime,
    qty: float = 1.0,
    price: float = 1.0,
    oid: str = "",
) -> Fill:
    return Fill(
        account=account,
        symbol=symbol,
        strike=strike,
        expiry=expiry,
        effect=effect,
        side=side,
        ts=ts,
        qty=qty,
        price=price,
        order_id=oid or f"{effect}-{strike}-{ts.isoformat()}",
    )


def test_hold_breakeven_includes_prior_roll_pnl_leg_only():
    """Hold B/E matches assign basis when prior rolls known; hold pnl_usd is this leg only."""
    today = date(2025, 11, 10)
    exp = date(2025, 11, 20)
    ch = {
        "spot": 15.0,
        "rows": [
            {"side": "put", "expiry": str(exp), "strike": 16, "bid": 0.5, "ask": 0.6, "iv": 0.5, "delta": -0.3},
        ],
    }
    out = build_options(
        16, exp, 1.0, 0.90, 0.50, ch, None, today,
        prior_roll_ps=0.60, prior_roll_total=60.0, roll_hops=1, roll_note=None,
    )
    assert out["hold"]["breakeven"] == pytest.approx(14.5, abs=0.0001)
    assert out["assign"]["basis"] == pytest.approx(14.5, abs=0.0001)
    assert out["hold"]["pnl_usd"] == pytest.approx(40.0, abs=0.01)
    unknown = build_options(
        16, exp, 1.0, 0.90, 0.50, ch, None, today,
        prior_roll_ps=0.60, prior_roll_total=60.0, roll_hops=0, roll_note="roll credits unknown",
    )
    assert unknown["hold"]["breakeven"] == pytest.approx(15.1, abs=0.0001)


def test_one_hop_roll_sums_to_cent():
    """Qty 1: open 1.00, close 0.40, reopen 0.90 → prior 0.60 per share."""
    acct, sym = "5QU47796", "IREN"
    t0 = datetime(2025, 11, 11, 15, 0, 0)
    fills = [
        _f(acct, sym, 17, date(2025, 11, 13), "open", "sell", t0 - timedelta(days=7), price=1.00, oid="o1"),
        _f(acct, sym, 17, date(2025, 11, 13), "close", "buy", t0, price=0.40, oid="c1"),
        _f(acct, sym, 16, date(2025, 11, 20), "open", "sell", t0 + timedelta(seconds=25), price=0.90, oid="o2"),
    ]
    r = compute_prior_roll_credits(fills, acct, sym, 16, date(2025, 11, 20), qty=1.0)
    assert r.roll_hops == 1
    assert r.roll_note is None
    assert r.prior_per_share == pytest.approx(0.60, abs=0.001)
    assert r.prior_total_usd == pytest.approx(60.0, abs=0.01)


def test_never_rolled_put_unchanged():
    acct, sym = "ACC", "AAA"
    t0 = datetime(2025, 10, 1, 12, 0, 0)
    fills = [_f(acct, sym, 50, date(2025, 10, 17), "open", "sell", t0, price=1.25)]
    r = compute_prior_roll_credits(fills, acct, sym, 50, date(2025, 10, 17), qty=2.0)
    assert r.roll_hops == 0
    assert r.prior_per_share == 0.0
    assert r.prior_total_usd == 0.0
    assert r.roll_note is None


def test_close_open_two_hours_apart_not_linked():
    acct, sym = "ACC", "BBB"
    t0 = datetime(2025, 11, 5, 10, 0, 0)
    fills = [
        _f(acct, sym, 30, date(2025, 11, 14), "open", "sell", t0 - timedelta(days=3), price=0.80),
        _f(acct, sym, 30, date(2025, 11, 14), "close", "buy", t0, price=0.30),
        _f(acct, sym, 28, date(2025, 11, 21), "open", "sell", t0 + timedelta(hours=2), price=0.70),
    ]
    r = compute_prior_roll_credits(fills, acct, sym, 28, date(2025, 11, 21), qty=1.0)
    assert r.roll_hops == 0
    assert r.prior_per_share == 0.0
    assert r.roll_note is not None
    assert "possible roll" in r.roll_note
    assert "not counted" in r.roll_note


def test_duplicated_snapshot_rows_do_not_change_sum():
    """Two Fill rows with same order_id (deduped upstream) — only one counts."""
    acct, sym = "ACC", "CCC"
    t0 = datetime(2025, 9, 1, 14, 0, 0)
    base = _f(acct, sym, 40, date(2025, 9, 19), "open", "sell", t0 - timedelta(days=5), price=1.10, oid="dup-open")
    dup = Fill(
        account=base.account,
        symbol=base.symbol,
        strike=base.strike,
        expiry=base.expiry,
        effect=base.effect,
        side=base.side,
        ts=base.ts,
        qty=base.qty,
        price=base.price,
        order_id=base.order_id,
    )
    fills = [
        dup,
        base,
        _f(acct, sym, 40, date(2025, 9, 19), "close", "buy", t0, price=0.50, oid="c"),
        _f(acct, sym, 38, date(2025, 10, 3), "open", "sell", t0 + timedelta(minutes=1), price=0.95, oid="o2"),
    ]
    # Caller must dedupe by order_id; simulate deduped list (one open row)
    deduped = [fills[0], fills[2], fills[3]]
    r = compute_prior_roll_credits(deduped, acct, sym, 38, date(2025, 10, 3), qty=1.0)
    assert r.prior_per_share == pytest.approx(0.60, abs=0.001)


def test_one_close_linked_to_single_later_open():
    """Greedy used-set: earliest open by fill time claims the shared buy-to-close."""
    acct, sym = "ACC", "DDD"
    t0 = datetime(2025, 11, 5, 10, 0, 0)
    fills = [
        _f(acct, sym, 30, date(2025, 11, 14), "open", "sell", t0 - timedelta(days=3), price=0.80, oid="o0"),
        _f(acct, sym, 30, date(2025, 11, 14), "close", "buy", t0, price=0.30, oid="c1"),
        _f(acct, sym, 28, date(2025, 11, 21), "open", "sell", t0 + timedelta(minutes=1), price=0.70, oid="o1"),
        _f(acct, sym, 27, date(2025, 11, 28), "open", "sell", t0 + timedelta(minutes=2), price=0.65, oid="o2"),
    ]
    used: set[str] = set()
    r_first = compute_prior_roll_credits(fills, acct, sym, 28, date(2025, 11, 21), 1.0, used=used)
    r_second = compute_prior_roll_credits(fills, acct, sym, 27, date(2025, 11, 28), 1.0, used=used)
    assert r_first.roll_hops == 1
    assert r_first.prior_per_share == pytest.approx(0.50, abs=0.001)
    assert r_second.roll_hops == 0
    assert r_second.prior_per_share == 0.0
    assert "c1" in used