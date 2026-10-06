"""LSEG Workspace connectivity + entitlement probe (read-only, no DB writes).

Requires the LSEG/Refinitiv Workspace desktop app running and logged in,
and LSEG_APP_KEY in repo-root .env.local (Workspace search: APPKEY).

Usage: .venv/bin/python lseg_check.py [RIC ...]
"""
import sys

from _session import lseg_session

# One field per call so a bad name / missing entitlement doesn't sink the rest.
PROBES = {
    "price": ["TR.PriceClose"],
    "consensus": ["TR.EPSMean(Period=FY1)", "TR.EPSNumIncEstimates(Period=FY1)", "TR.RecMean", "TR.PriceTargetMean"],
    "fiscal_period": ["TR.EPSMean(Period=FY1).fperiod", "TR.EPSMean(Period=FY1).periodenddate"],
    "starmine": ["TR.ARM100Region", "TR.CombinedAlphaRegionRank", "TR.ValMoRegionRank",
                 "TR.EPSSmartEst(Period=FY1)", "TR.EPSPreSurprisePct(Period=FQ1)"],
    "short_interest": ["TR.ShortInterest", "TR.ShortInterestPct", "TR.FreeFloat"],
    "ids": ["TR.TickerSymbol", "TR.CUSIP", "TR.ISIN"],
    "credit": ["TR.IssuerRating", "TR.CDSPrimaryCDSRic"],
    "next_event": ["TR.EventStartDate", "TR.EventType", "TR.EventTitle"],
}


def main() -> None:
    rics = sys.argv[1:] or ["AAPL.O", "NVDA.O"]
    with lseg_session() as ld:
        print("session:", ld.session.get_default().open_state)
        for label, fields in PROBES.items():
            for f in fields:
                try:
                    df = ld.get_data(rics, [f])
                    print(f"OK   {label:15s} {f:45s} {df.iloc[:, 1:].to_dict('records')}")
                except Exception as e:  # entitlement or field-name failure
                    print(f"FAIL {label:15s} {f:45s} {str(e)[:120]}")
        try:
            h = ld.get_history(rics[0], start="2026-09-01")
            print(f"OK   history         {rics[0]} rows={len(h)}")
        except Exception as e:
            print(f"FAIL history         {str(e)[:120]}")


if __name__ == "__main__":
    main()
