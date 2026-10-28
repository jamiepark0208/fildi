"""S113 robustness: realized revenue growth by consensus 2-y growth decile (medians, not OLS). Same sample as
consensus_width.py (Compustat × IBES SAL, 2000–2019, revenue ≥ $0.5B). Output → out/consensus_deciles.csv.
Usage: research/wrds/.venv/bin/python research/fair_value/consensus_deciles.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wrds"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _auth import connect
from consensus_width import Q, OUT

BODY = Q.split("), fit AS (")[0] + """)
SELECT CASE WHEN size = '1: $0.5-2B' THEN 'small' ELSE 'large' END sz, NTILE(10) OVER (PARTITION BY size = '1: $0.5-2B' ORDER BY c2) dec, c2, r13, r45, r15, r610
FROM d"""
Q2 = f"""WITH x AS ({BODY.replace('WITH f AS', 'WITH f AS', 1)})
SELECT sz, dec, COUNT(*) n, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY c2) c2,
  PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY r13) r13, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY r45) r45,
  PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY r15) r15, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY r610) r610,
  PERCENTILE_CONT(.1) WITHIN GROUP (ORDER BY r15) r15_p10, PERCENTILE_CONT(.9) WITHIN GROUP (ORDER BY r15) r15_p90
FROM x GROUP BY 1, 2 ORDER BY 1, 2"""

if __name__ == "__main__":
    db = connect()
    df = db.raw_sql(Q2)
    db.close()
    df.to_csv(OUT / "consensus_deciles.csv", index=False)
    print(df.round(3).to_string(index=False))
