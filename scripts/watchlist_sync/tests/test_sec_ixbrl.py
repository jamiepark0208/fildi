"""11-11 #53: filing inline XBRL → companyfacts merge (lagging SEC filers)."""
import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parents[1] / "dcf")]
import sec_ixbrl as X  # noqa: E402

DOC = """
<xbrli:context id="q"><xbrli:entity/><xbrli:period><xbrli:startDate>2026-07-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="ytd"><xbrli:entity/><xbrli:period><xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="seg"><xbrli:entity><xbrli:segment><xbrldi:explicitMember>x</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="i"><xbrli:entity/><xbrli:period><xbrli:instant>2026-10-20</xbrli:instant></xbrli:period></xbrli:context>
<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
<xbrli:unit id="sh"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>
<xbrli:unit id="eps"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>
<ix:nonFraction name="us-gaap:NetIncomeLoss" contextRef="ytd" unitRef="usd" scale="6">10,102</ix:nonFraction>
<ix:nonFraction name="us-gaap:NetIncomeLoss" contextRef="ytd" unitRef="usd" scale="6">10,102</ix:nonFraction>
<ix:nonFraction name="us-gaap:NetIncomeLoss" contextRef="seg" unitRef="usd" scale="6">1</ix:nonFraction>
<ix:nonFraction name="us-gaap:NetIncomeLoss" contextRef="q" unitRef="usd" scale="6" sign="-">22</ix:nonFraction>
<ix:nonFraction name="us-gaap:EarningsPerShareDiluted" contextRef="q" unitRef="eps">1.99</ix:nonFraction>
<ix:nonFraction name="dei:EntityCommonStockSharesOutstanding" contextRef="i" unitRef="sh">118,587,861</ix:nonFraction>
"""
META = {"form": "10-Q", "filed": "2026-11-05", "accn": "x"}


def test_parse_consolidated_dedup_sign_units():
    f = X.parse_facts(DOC)
    ni = [x for x in f if x["concept"] == "NetIncomeLoss"]
    assert sorted(x["val"] for x in ni) == [-22e6, 10102e6]          # segment skipped, duplicate once, sign applied
    assert next(x for x in f if x["concept"] == "EarningsPerShareDiluted")["unit"] == "USD/shares"
    sh = next(x for x in f if x["concept"] == "EntityCommonStockSharesOutstanding")
    assert sh["unit"] == "shares" and "start" not in sh


def test_augment_replaces_same_period_and_tags_fp():
    facts = {"facts": {"dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": [
        {"end": "2026-10-20", "val": 118587861, "form": "10-Q", "filed": "2026-10-26"}]}}}}}
    X.augment(facts, X.parse_facts(DOC), META)
    sh = facts["facts"]["dei"]["EntityCommonStockSharesOutstanding"]["units"]["shares"]
    assert len(sh) == 1                                              # SEIC: appended copy doubled the class sum
    ni = facts["facts"]["us-gaap"]["NetIncomeLoss"]["units"]["USD"]
    assert {u["fp"] for u in ni} == {"Q1", "Q3"}                     # 3-month → Q1 range, 9-month → Q3 (YTD lookup)


if __name__ == "__main__":
    for k, fn in list(globals().items()):
        if k.startswith("test_"):
            fn()
            print("ok", k)
