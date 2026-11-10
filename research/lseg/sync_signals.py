"""Daily LSEG signal snapshot → lseg_research.signals_daily.

Current consensus, StarMine (ARM / Combined Alpha / ValMo / SmartEstimate / Predicted Surprise),
short interest, issuer rating, CDS RIC. History of IBES consensus is WRDS-owned — this is "now" only.

Usage: .venv/bin/python sync_signals.py [--tickers NVDA,MSFT | --universe book|registry] [--force]
Run sync_ids.py first (needs RICs in research_common.security_map).
"""
from __future__ import annotations

import argparse
from datetime import date, timedelta

from _session import add_lseg_universe_args, resolve_lseg_universe, clean, connect_local, load_ric_map, lseg_session
from db import ensure_schema, log_pull, upsert_sync_state

DATASET = "signals_daily"

# (column, field) — fetched in groups; values read by position, not display name
# (display names collide, e.g. two "Earnings Per Share - Mean").
GROUPS: list[list[tuple[str, str]]] = [
    [
        ("price_close", "TR.PriceClose"),
        ("rec_mean", "TR.RecMean"),
        ("pt_mean", "TR.PriceTargetMean"),
        ("arm_rank", "TR.ARM100Region"),
        ("combined_alpha_rank", "TR.CombinedAlphaRegionRank"),
        ("valmo_rank", "TR.ValMoRegionRank"),
        ("short_interest", "TR.ShortInterest"),
        ("short_pct", "TR.ShortInterestPct"),
        ("free_float", "TR.FreeFloat"),
        ("shares_out", "TR.SharesOutstanding"),
        ("issuer_rating", "TR.IssuerRating"),
        ("cds_ric", "TR.CDSPrimaryCDSRic"),
        ("credit_combined_rank", "TR.CreditComboRegionRank"),
        ("price_mo_rank", "TR.PriceMoRegionRank"),
        ("relval_rank", "TR.RelValRegionRank"),
        ("price_to_intrinsic", "TR.IVPriceToIntrinsicValue"),
        ("imp_volt", "IMP_VOLT"),
    ],
    [
        # Jamie 10-29 (A283 street range): spread of targets, not just the mean
        ("pt_median", "TR.PriceTargetMedian"),
        ("pt_high", "TR.PriceTargetHigh"),
        ("pt_low", "TR.PriceTargetLow"),
        ("pt_num_est", "TR.PriceTargetNumIncEstimates"),
    ],
    [
        # Next-quarter dispersion: how much analysts disagree about the coming print.
        ("eps_mean_fq1", "TR.EPSMean(Period=FQ1)"),
        ("eps_std_fq1", "TR.EPSStdDev(Period=FQ1)"),
        ("eps_high_fq1", "TR.EPSHigh(Period=FQ1)"),
        ("eps_low_fq1", "TR.EPSLow(Period=FQ1)"),
        ("eps_num_est_fq1", "TR.EPSNumIncEstimates(Period=FQ1)"),
        ("rev_pred_surprise_pct_fq1", "TR.RevenuePreSurprisePct(Period=FQ1)"),
    ],
    [
        ("eps_mean_fy1", "TR.EPSMean(Period=FY1)"),
        ("fy1_period", "TR.EPSMean(Period=FY1).fperiod"),
        ("fy1_period_end", "TR.EPSMean(Period=FY1).periodenddate"),
        ("eps_num_est_fy1", "TR.EPSNumIncEstimates(Period=FY1)"),
        ("revenue_mean_fy1", "TR.RevenueMean(Period=FY1)"),
        ("eps_smart_fy1", "TR.EPSSmartEst(Period=FY1)"),
        ("pred_surprise_pct_fq1", "TR.EPSPreSurprisePct(Period=FQ1)"),
        ("fq1_period_end", "TR.EPSPreSurprisePct(Period=FQ1).periodenddate"),
    ],
    [
        # Explicit calendar date: relative "-30D" counts trading days in LSEG formulas.
        ("eps_mean_fy1_30d_ago", "TR.EPSMean(Period=FY1,SDate={d30})"),
        ("_fy1_period_end_30d_ago", "TR.EPSMean(Period=FY1,SDate={d30}).periodenddate"),
    ],
    [
        # 11-09: IBES on WRDS stops at 08-20 → lab_fund revision features (drift_3m, fwd growth, dispersion) from here.
        ("eps_mean_fy1_90d_ago", "TR.EPSMean(Period=FY1,SDate={d90})"),
        ("_fy1_period_end_90d_ago", "TR.EPSMean(Period=FY1,SDate={d90}).periodenddate"),
        ("eps_mean_fy2", "TR.EPSMean(Period=FY2)"),
        ("eps_std_fy1", "TR.EPSStdDev(Period=FY1)"),
    ],
]

COLS = [
    "price_close", "eps_mean_fy1", "eps_mean_fy1_30d_ago", "eps_drift_30d_pct", "eps_num_est_fy1",
    "fy1_period", "fy1_period_end", "revenue_mean_fy1", "rec_mean", "pt_mean", "pt_upside_pct",
    "eps_smart_fy1", "smart_vs_cons_pct", "pred_surprise_pct_fq1", "fq1_period_end", "arm_rank",
    "combined_alpha_rank", "valmo_rank", "short_interest", "short_pct", "free_float", "shares_out",
    "issuer_rating", "cds_ric",
    "credit_combined_rank", "price_mo_rank", "relval_rank", "price_to_intrinsic",
    "eps_mean_fq1", "eps_std_fq1", "eps_high_fq1", "eps_low_fq1", "eps_num_est_fq1", "rev_pred_surprise_pct_fq1",
    "imp_volt", "pt_median", "pt_high", "pt_low", "pt_num_est",
    "eps_mean_fy1_90d_ago", "eps_mean_fy2", "eps_std_fy1", "eps_num_up_fy1", "eps_num_down_fy1", "eps_num_brokers_fy1",
]
INT_COLS = {"eps_num_est_fy1", "arm_rank", "combined_alpha_rank", "valmo_rank",
            "credit_combined_rank", "price_mo_rank", "relval_rank", "eps_num_est_fq1", "pt_num_est",
            "eps_num_up_fy1", "eps_num_down_fy1", "eps_num_brokers_fy1"}
DATE_COLS = {"fy1_period_end", "fq1_period_end", "_fy1_period_end_30d_ago", "_fy1_period_end_90d_ago"}

UPSERT = f"""
INSERT INTO lseg_research.signals_daily (ticker, as_of, ric, {", ".join(COLS)}, fetched_at)
VALUES (%s, %s, %s, {", ".join(["%s"] * len(COLS))}, now())
ON CONFLICT (ticker, as_of) DO UPDATE SET
  ric = EXCLUDED.ric, {", ".join(f"{c} = EXCLUDED.{c}" for c in COLS)}, fetched_at = now()
"""


def pct(a, b):
    """% change from b to a, sign-correct for negative bases (loss widening -0.62 → -0.64 is negative)."""
    return (a - b) / abs(b) * 100 if a is not None and b not in (None, 0) else None


def fetch(ld, rics: list[str], breadth_rics: list[str] | None = None) -> dict[str, dict]:
    out: dict[str, dict] = {r: {} for r in rics}
    d30 = (date.today() - timedelta(days=30)).isoformat()
    d90 = (date.today() - timedelta(days=90)).isoformat()
    for group in GROUPS:
        df = ld.get_data(rics, [f.format(d30=d30, d90=d90) for _, f in group])
        for _, row in df.iterrows():
            rec = out.setdefault(row.iloc[0], {})
            for i, (col, _) in enumerate(group, start=1):
                v = clean(row.iloc[i])
                if v is None or rec.get(col) is not None:  # first non-null wins
                    continue
                if col in DATE_COLS:
                    v = v.date() if hasattr(v, "date") else v
                elif col in INT_COLS:
                    v = int(v)
                rec[col] = v
    for rec in out.values():
        # Drift only when both readings refer to the same fiscal year (FY1 can roll over).
        same_fy = rec.get("fy1_period_end") and rec.get("fy1_period_end") == rec.pop("_fy1_period_end_30d_ago", None)
        if not same_fy:
            rec["eps_mean_fy1_30d_ago"] = None
        if not (rec.get("fy1_period_end") and rec.get("fy1_period_end") == rec.pop("_fy1_period_end_90d_ago", None)):
            rec["eps_mean_fy1_90d_ago"] = None
        rec["eps_drift_30d_pct"] = pct(rec.get("eps_mean_fy1"), rec.get("eps_mean_fy1_30d_ago"))
        rec["pt_upside_pct"] = pct(rec.get("pt_mean"), rec.get("price_close"))
        rec["smart_vs_cons_pct"] = pct(rec.get("eps_smart_fy1"), rec.get("eps_mean_fy1"))
    try:
        if breadth_rics:
            breadth(ld, breadth_rics, d30, out)
    except Exception as e:  # noqa: BLE001 — breadth is an extra; never lose the core snapshot over it
        print(f"warn: broker breadth failed: {str(e)[:200]}")
    return out


def breadth(ld, rics: list[str], d30: str, out: dict[str, dict], chunk: int = 200) -> None:
    """IBES-style breadth from per-broker FY1 estimates: rose / fell vs the same broker 30 days ago.
    Brokers are keyed by name (unlicensed ones read "Permission Denied <id>", still unique)."""
    for k in range(0, len(rics), chunk):
        _breadth_part(ld, rics[k:k + chunk], d30, out)


def _breadth_part(ld, part: list[str], d30: str, out: dict[str, dict]) -> None:
    """One chunk; a backend 400 (seen 11-09 on one 200-name chunk) splits it in half down to 25 names, then gives up."""
    try:
        _breadth_fetch(ld, part, d30, out)
    except Exception as e:  # noqa: BLE001
        if len(part) <= 25:
            print(f"warn: breadth skipped {len(part)} names ({part[0]}…): {str(e)[:80]}")
            return
        h = len(part) // 2
        _breadth_part(ld, part[:h], d30, out)
        _breadth_part(ld, part[h:], d30, out)


def _breadth_fetch(ld, part: list[str], d30: str, out: dict[str, dict]) -> None:
    snap: dict[str, dict[str, dict]] = {}
    for tag, sd in (("now", None), ("old", d30)):
        arg = f"Period=FY1,SDate={sd}" if sd else "Period=FY1"
        df = ld.get_data(part, [f"TR.EPSEstValue({arg})", f"TR.EPSEstValue({arg}).brokername",
                                f"TR.EPSEstValue({arg}).periodenddate"])
        for _, row in df.iterrows():
            v, b, pe = clean(row.iloc[1]), clean(row.iloc[2]), clean(row.iloc[3])
            if v is None or b is None:
                continue
            snap.setdefault(row.iloc[0], {}).setdefault(tag, {})[b] = (float(v), pe)
    for ric, s in snap.items():
        now, old = s.get("now", {}), s.get("old", {})
        if not now:
            continue
        same = [b for b in now if b in old and now[b][1] == old[b][1]]   # same fiscal year only
        rec = out.setdefault(ric, {})
        rec["eps_num_brokers_fy1"] = len(now)
        rec["eps_num_up_fy1"] = sum(now[b][0] > old[b][0] for b in same)
        rec["eps_num_down_fy1"] = sum(now[b][0] < old[b][0] for b in same)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    add_lseg_universe_args(p)
    args = p.parse_args()
    # tier 8 = whole app universe: one cheap snapshot a day (consensus EPS / targets / StarMine) for fair value and
    # fund scores; history syncs stay on tiers ≤ 7 (10-27)
    tickers = resolve_lseg_universe(args, max_tier=8)
    today = date.today()

    with connect_local() as conn:
        ensure_schema(conn)
        have = {r[0] for r in conn.execute(
            "SELECT ticker FROM lseg_research.signals_daily WHERE as_of = %s AND ticker = ANY(%s)",
            (today, tickers)).fetchall()}
    todo = tickers if args.force else [t for t in tickers if t not in have]
    if not todo:
        print(f"skip: all {len(tickers)} tickers already snapshotted for {today}. Use --force.")
        return

    ric_map = load_ric_map(todo)
    no_ric = [t for t in todo if t not in ric_map]
    if no_ric:
        print(f"warn: no RIC for {no_ric} — run sync_ids.py --tickers {','.join(no_ric)}")
    todo = [t for t in todo if t in ric_map]

    with connect_local() as conn:
        try:
            with lseg_session() as ld:
                # breadth = one detail pull per broker (~140k datapoints for the universe) → weekly is enough (IBES was monthly)
                fresh = {r[0] for r in conn.execute(
                    """SELECT DISTINCT ticker FROM lseg_research.signals_daily WHERE as_of > %s AND as_of < %s
                       AND eps_num_brokers_fy1 IS NOT NULL""", (today - timedelta(days=7), today)).fetchall()}
                data = fetch(ld, [ric_map[t] for t in todo], [ric_map[t] for t in todo if t not in fresh])
        except Exception as e:
            log_pull(conn, dataset=DATASET, status="error", tickers=todo, error=str(e)[:500])
            conn.commit()
            raise
        rows = [(t, today, ric_map[t], *[data.get(ric_map[t], {}).get(c) for c in COLS]) for t in todo]
        with conn.cursor() as cur:
            cur.executemany(UPSERT, rows)
        upsert_sync_state(conn, dataset=DATASET, watermark=today.isoformat(), rows=len(rows), tickers=todo,
                          notes=f"no RIC: {','.join(no_ric)}" if no_ric else "")
        log_pull(conn, dataset=DATASET, status="ok" if not no_ric else "partial", tickers=todo,
                 rows=len(rows), watermark_to=today.isoformat())
        conn.commit()
    print(f"{DATASET}: upserted {len(rows)} rows for {today}")


if __name__ == "__main__":
    main()
