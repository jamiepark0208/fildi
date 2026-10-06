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
]

COLS = [
    "price_close", "eps_mean_fy1", "eps_mean_fy1_30d_ago", "eps_drift_30d_pct", "eps_num_est_fy1",
    "fy1_period", "fy1_period_end", "revenue_mean_fy1", "rec_mean", "pt_mean", "pt_upside_pct",
    "eps_smart_fy1", "smart_vs_cons_pct", "pred_surprise_pct_fq1", "fq1_period_end", "arm_rank",
    "combined_alpha_rank", "valmo_rank", "short_interest", "short_pct", "free_float", "shares_out",
    "issuer_rating", "cds_ric",
    "credit_combined_rank", "price_mo_rank", "relval_rank", "price_to_intrinsic",
    "eps_mean_fq1", "eps_std_fq1", "eps_high_fq1", "eps_low_fq1", "eps_num_est_fq1", "rev_pred_surprise_pct_fq1",
    "imp_volt",
]
INT_COLS = {"eps_num_est_fy1", "arm_rank", "combined_alpha_rank", "valmo_rank",
            "credit_combined_rank", "price_mo_rank", "relval_rank", "eps_num_est_fq1"}
DATE_COLS = {"fy1_period_end", "fq1_period_end", "_fy1_period_end_30d_ago"}

UPSERT = f"""
INSERT INTO lseg_research.signals_daily (ticker, as_of, ric, {", ".join(COLS)}, fetched_at)
VALUES (%s, %s, %s, {", ".join(["%s"] * len(COLS))}, now())
ON CONFLICT (ticker, as_of) DO UPDATE SET
  ric = EXCLUDED.ric, {", ".join(f"{c} = EXCLUDED.{c}" for c in COLS)}, fetched_at = now()
"""


def pct(a, b):
    """% change from b to a, sign-correct for negative bases (loss widening -0.62 → -0.64 is negative)."""
    return (a - b) / abs(b) * 100 if a is not None and b not in (None, 0) else None


def fetch(ld, rics: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {r: {} for r in rics}
    d30 = (date.today() - timedelta(days=30)).isoformat()
    for group in GROUPS:
        df = ld.get_data(rics, [f.format(d30=d30) for _, f in group])
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
        rec["eps_drift_30d_pct"] = pct(rec.get("eps_mean_fy1"), rec.get("eps_mean_fy1_30d_ago"))
        rec["pt_upside_pct"] = pct(rec.get("pt_mean"), rec.get("price_close"))
        rec["smart_vs_cons_pct"] = pct(rec.get("eps_smart_fy1"), rec.get("eps_mean_fy1"))
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    add_lseg_universe_args(p)
    args = p.parse_args()
    tickers = resolve_lseg_universe(args)
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
                data = fetch(ld, [ric_map[t] for t in todo])
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
