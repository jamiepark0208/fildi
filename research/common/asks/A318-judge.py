"""A318 seg 1+2 eval: judge the ratio cells vs SEC companyfacts (latest 10-Q/10-K TTM). Scratch, not shipped."""
import json, sys
from datetime import date, timedelta
sys.path.insert(0, "/Users/jamiepark/Cursor/fildi/scripts/watchlist_sync")
sys.path.insert(0, "/Users/jamiepark/Cursor/fildi/scripts/watchlist_sync/dcf")
import financials as F
from build_plan import connect, rows

FRACTION = {"grossMargin", "netMargin", "operatingMargin", "returnOnAssets", "dividendYield"}
NI = ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"]
REV = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenuesNetOfInterestExpense", "SalesRevenueNet"]
ASSETS = ["Assets"]
EQ = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]
DIV = ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"]


def ok(v, t, field):
    if v is None or t is None:
        return None
    band = max(abs(t) * 0.20, 0.03 if field in FRACTION else 0)
    return abs(v - t) <= band


def ttm_per_share(facts, concepts):
    for c in concepts:
        node = facts.get("facts", {}).get("us-gaap", {}).get(c)
        if not node:
            continue
        vals = F._units({"facts": {"us-gaap": {c: node}}}, c, "USD/shares")
        if not vals:
            continue
        fake = {"facts": {"us-gaap": {c: {"units": {"USD": vals}}}}}
        r = F.ttm_flow(fake, [c])
        if r:
            return r
    return None


def price(conn, t):
    r = rows(conn, "SELECT close, date FROM prices_historical WHERE ticker=%s ORDER BY date DESC LIMIT 1", (t,))
    return (float(r[0]["close"]), str(r[0]["date"])) if r else (None, None)


def main():
    cells = json.load(open("/Users/jamiepark/Cursor/fildi/research/common/asks/A318-seg12-eval.json"))["sample"]
    conn = connect()
    cache = {}
    out = []
    for c in cells:
        t, f = c["ticker"], c["field"]
        if f in ("freeCashFlow", "totalRevenue") or (f == "operatingMargin" and t == "TTWO"):
            continue  # judged last session
        if t not in cache:
            try:
                cache[t] = F.companyfacts(conn, t)
            except Exception as e:  # noqa: BLE001
                cache[t] = None
                print("fetch fail", t, e, file=sys.stderr)
        facts = cache[t]
        truth, note = None, ""
        if not facts or not facts.get("facts", {}).get("us-gaap"):
            note = "no us-gaap companyfacts (foreign filer?)"
        else:
            rev = F.ttm_flow(facts, REV)
            asof = (rev or {}).get("end") or date.today().isoformat()
            ni = F.ttm_flow(facts, ["NetIncomeLoss"]) or F.ttm_flow(facts, NI)
            if f == "returnOnAssets":
                a = F.balance(facts, ASSETS, asof)
                a0 = F.balance(facts, ASSETS, (date.fromisoformat(a["end"]) - timedelta(days=360)).isoformat()) if a else None
                if ni and a:
                    avg = (a["value"] + a0["value"]) / 2 if a0 and a0["value"] else a["value"]
                    truth = ni["value"] / avg
                    note = f"NI {ni['value']/1e6:.0f}M ({ni['end']}) / avg assets {avg/1e6:.0f}M; end-assets ROA {ni['value']/a['value']:.4f}"
            elif f in ("grossMargin", "netMargin", "operatingMargin"):
                num = {"grossMargin": F.ttm_flow(facts, ["GrossProfit"]),
                       "netMargin": ni,
                       "operatingMargin": F.ttm_flow(facts, ["OperatingIncomeLoss"])}[f]
                if f == "grossMargin" and not num:
                    cogs = F.ttm_flow(facts, ["CostOfGoodsAndServicesSold", "CostOfRevenue"])
                    num = {"value": rev["value"] - cogs["value"], "end": cogs["end"]} if cogs and rev else None
                if num and rev:
                    truth = num["value"] / rev["value"]
                    note = f"{num['value']/1e6:.0f}M / rev {rev['value']/1e6:.0f}M ({rev['end']})"
            elif f == "currentRatio":
                ca, cl = F.balance(facts, ["AssetsCurrent"], asof), F.balance(facts, ["LiabilitiesCurrent"], asof)
                if ca and cl and cl["value"]:
                    truth = ca["value"] / cl["value"]
                    note = f"CA {ca['value']/1e6:.0f}M / CL {cl['value']/1e6:.0f}M ({ca['end']})"
                else:
                    note = "unclassified balance sheet (no AssetsCurrent/LiabilitiesCurrent)"
            elif f == "priceToBook":
                eq, sh = F.balance(facts, EQ, asof), F.shares(facts)
                p, pd = price(conn, t)
                if eq and sh and p:
                    truth = p * sh["value"] / eq["value"]
                    note = f"px {p} ({pd}) × {sh['value']/1e6:.1f}M sh / eq {eq['value']/1e6:.0f}M ({eq['end']})"
            elif f == "dividendYield":
                d = ttm_per_share(facts, DIV)
                p, pd = price(conn, t)
                if d and p:
                    truth = d["value"] / p
                    note = f"DPS TTM {d['value']:.3f} ({d['end']}) / px {p}"
            elif f == "sharesOutstanding":
                sh = F.shares(facts)
                truth = sh["value"] if sh else None
                note = f"dei {sh}" if sh else ""
            elif f == "netIncome":
                truth = ni["value"] if ni else None
                note = f"{ni['how']} end {ni['end']}" if ni else ""
            elif f == "ffoProxy":
                da = F.ttm_flow(facts, ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet"])
                if ni and da:
                    truth = ni["value"] + da["value"]
                    note = f"NI {ni['value']/1e6:.0f}M ({ni['end']}) + D&A {da['value']/1e6:.0f}M ({da['end']})"
            else:
                note = "forward/estimate field: not filing-checkable"
        b, a = float(c["beforeGold"]), float(c["afterGold"])
        out.append(dict(ticker=t, field=f, before=b, after=a, truth=truth, before_ok=ok(b, truth, f), after_ok=ok(a, truth, f), note=note))
    for r in out:
        tr = "—" if r["truth"] is None else f"{r['truth']:.4g}"
        print(f"{r['ticker']:5} {r['field']:17} before {r['before']:.4g} {'✓' if r['before_ok'] else '✗' if r['before_ok'] is False else '?'}  "
              f"after {r['after']:.4g} {'✓' if r['after_ok'] else '✗' if r['after_ok'] is False else '?'}  SEC {tr}  | {r['note']}")
    json.dump(out, open(sys.argv[1], "w"), indent=1, default=str)


main()
