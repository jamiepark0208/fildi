"""DCF v2 fix (d) — how much does revenue consensus narrow long-run growth uncertainty? (A283, study S113)
Compustat US firm-years 2000–2019 (revenue ≥ $0.5B) linked to IBES SAL consensus (statsum_xepsus) ~3 months after the
fiscal year end: c2 = consensus 2-y revenue CAGR (FY+2 mean vs actual sales). Within the engine's size × trailing-growth
buckets: spread of realized growth (years 1–3, 4–5, 1–5, 6–10) unconditional vs after a within-bucket regression on c2.
Output: residual P10–P90 ÷ unconditional P10–P90 = the factor that scales the base-rate spread for covered names.
Aggregated on the WRDS server; nothing per firm comes back.
Usage: research/wrds/.venv/bin/python research/fair_value/consensus_width.py"""
import sys
from pathlib import Path
import pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wrds"))
from _auth import connect

OUT = Path(__file__).parent / "out"

Q = """
WITH f AS (
  SELECT a.gvkey, a.fyear, a.datadate, a.sale
  FROM comp.funda a JOIN comp.company c ON c.gvkey = a.gvkey
  WHERE a.indfmt='INDL' AND a.datafmt='STD' AND a.popsrc='D' AND a.consol='C' AND a.curcd='USD' AND c.fic='USA'
    AND a.fyear BETWEEN 1996 AND 2025 AND a.sale > 0
), g AS (
  SELECT f.*,
    CASE WHEN LAG(fyear,3) OVER w = fyear-3 THEN LAG(sale,3) OVER w END AS s_m3,
    CASE WHEN LEAD(fyear,3) OVER w = fyear+3 THEN LEAD(sale,3) OVER w END AS s_p3,
    CASE WHEN LEAD(fyear,5) OVER w = fyear+5 THEN LEAD(sale,5) OVER w END AS s_p5,
    CASE WHEN LEAD(fyear,10) OVER w = fyear+10 THEN LEAD(sale,10) OVER w END AS s_p10
  FROM f WINDOW w AS (PARTITION BY gvkey ORDER BY fyear)
), b AS (
  SELECT g.*, POWER(sale / s_m3, 1/3.0) - 1 AS g_back,
    CASE WHEN sale < 2000 THEN '1: $0.5-2B' WHEN sale < 10000 THEN '2: $2-10B' ELSE '3: >$10B' END AS size
  FROM g WHERE sale >= 500 AND s_m3 > 0 AND s_p5 > 0 AND fyear BETWEEN 2000 AND 2019
), l AS (
  SELECT DISTINCT ON (b.gvkey, b.fyear) b.*, i.ticker
  FROM b JOIN crsp.ccmxpf_lnkhist k ON k.gvkey = b.gvkey AND k.linktype IN ('LU','LC') AND k.linkprim IN ('P','C')
       AND b.datadate BETWEEN k.linkdt AND COALESCE(k.linkenddt, '2099-12-31')
  JOIN wrdsapps.ibcrsphist i ON i.permno = k.lpermno AND b.datadate BETWEEN i.sdate AND i.edate AND i.score <= 2
  ORDER BY b.gvkey, b.fyear, i.score
), c AS (
  SELECT l.*, s.meanest AS fy2, s.numest
  FROM l JOIN LATERAL (
    SELECT meanest, numest FROM ibes.statsum_xepsus s
    WHERE s.ticker = l.ticker AND s.measure = 'SAL' AND s.fiscalp = 'ANN'
      AND s.fpedats BETWEEN l.datadate + 700 AND l.datadate + 760
      AND s.statpers BETWEEN l.datadate + 60 AND l.datadate + 130
    ORDER BY s.statpers LIMIT 1) s ON TRUE
), d AS (
  SELECT size,
    CASE WHEN g_back < 0 THEN '1: <0' WHEN g_back < .10 THEN '2: 0-10' WHEN g_back < .20 THEN '3: 10-20'
         WHEN g_back < .40 THEN '4: 20-40' ELSE '5: >40' END AS start_growth,
    numest, SQRT(fy2 / sale) - 1 AS c2,
    POWER(s_p3 / sale, 1/3.0) - 1 AS r13,
    CASE WHEN s_p3 > 0 THEN SQRT(s_p5 / s_p3) - 1 END AS r45,
    POWER(s_p5 / sale, 1/5.0) - 1 AS r15,
    CASE WHEN s_p10 > 0 THEN POWER(s_p10 / s_p5, 1/5.0) - 1 END AS r610
  FROM c WHERE fy2 / sale BETWEEN 0.4 AND 6 AND s_p3 > 0
), fit AS (
  SELECT size, start_growth, COUNT(*) n, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY numest) med_numest,
    REGR_SLOPE(r13, c2) b13, REGR_INTERCEPT(r13, c2) a13, CORR(r13, c2) rho13,
    REGR_SLOPE(r45, c2) b45, REGR_INTERCEPT(r45, c2) a45, CORR(r45, c2) rho45,
    REGR_SLOPE(r15, c2) b15, REGR_INTERCEPT(r15, c2) a15, CORR(r15, c2) rho15,
    REGR_SLOPE(r610, c2) b610, REGR_INTERCEPT(r610, c2) a610, CORR(r610, c2) rho610, COUNT(r610) n610
  FROM d GROUP BY 1, 2
)
SELECT f.size, f.start_growth, f.n, f.n610, f.med_numest, f.rho13, f.rho45, f.rho15, f.rho610, f.b15,
  PERCENTILE_CONT(.9) WITHIN GROUP (ORDER BY d.r13) - PERCENTILE_CONT(.1) WITHIN GROUP (ORDER BY d.r13) w13,
  PERCENTILE_CONT(.9) WITHIN GROUP (ORDER BY d.r13 - f.a13 - f.b13 * d.c2) - PERCENTILE_CONT(.1) WITHIN GROUP (ORDER BY d.r13 - f.a13 - f.b13 * d.c2) w13_res,
  PERCENTILE_CONT(.9) WITHIN GROUP (ORDER BY d.r45) - PERCENTILE_CONT(.1) WITHIN GROUP (ORDER BY d.r45) w45,
  PERCENTILE_CONT(.9) WITHIN GROUP (ORDER BY d.r45 - f.a45 - f.b45 * d.c2) - PERCENTILE_CONT(.1) WITHIN GROUP (ORDER BY d.r45 - f.a45 - f.b45 * d.c2) w45_res,
  PERCENTILE_CONT(.9) WITHIN GROUP (ORDER BY d.r15) - PERCENTILE_CONT(.1) WITHIN GROUP (ORDER BY d.r15) w15,
  PERCENTILE_CONT(.9) WITHIN GROUP (ORDER BY d.r15 - f.a15 - f.b15 * d.c2) - PERCENTILE_CONT(.1) WITHIN GROUP (ORDER BY d.r15 - f.a15 - f.b15 * d.c2) w15_res,
  PERCENTILE_CONT(.9) WITHIN GROUP (ORDER BY d.r610) - PERCENTILE_CONT(.1) WITHIN GROUP (ORDER BY d.r610) w610,
  PERCENTILE_CONT(.9) WITHIN GROUP (ORDER BY d.r610 - f.a610 - f.b610 * d.c2) - PERCENTILE_CONT(.1) WITHIN GROUP (ORDER BY d.r610 - f.a610 - f.b610 * d.c2) w610_res,
  PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY d.c2) c2_med, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY d.r15) r15_med
FROM d JOIN fit f USING (size, start_growth) GROUP BY f.size, f.start_growth, f.n, f.n610, f.med_numest, f.rho13, f.rho45, f.rho15, f.rho610, f.b15
ORDER BY 1, 2
"""


def main() -> None:
    db = connect()
    df = db.raw_sql(Q)
    db.close()
    for k in ("13", "45", "15", "610"):
        df[f"k{k}"] = df[f"w{k}_res"] / df[f"w{k}"]
    OUT.mkdir(exist_ok=True)
    df.to_csv(OUT / "consensus_width.csv", index=False)
    pd.set_option("display.width", 250)
    print(df[["size", "start_growth", "n", "n610", "med_numest", "rho13", "rho45", "rho15", "rho610", "b15", "c2_med", "r15_med",
              "w15", "k13", "k45", "k15", "k610"]].round(2).to_string(index=False))
    w = lambda col: (df[col] * df["n"]).sum() / df["n"].sum()
    print(f"\nn-weighted narrowing (residual ÷ unconditional P10–P90): yr1–3 {w('k13'):.2f} · yr4–5 {w('k45'):.2f} · "
          f"yr1–5 {w('k15'):.2f} · yr6–10 {w('k610'):.2f}")


if __name__ == "__main__":
    main()
