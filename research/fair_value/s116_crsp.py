"""S116 helper: CRSP monthly returns for the backtest names → research/fair_value/out/s116_crsp_msf.csv (research only).
One query: permno by current ticker (crsp.stocknames, latest name), crsp.msf 2012-01 → latest (prc, ret, shrout, cfacpr),
crsp.msi value-weighted market return. One-off research pull (PLAYBOOK's ≤ 50-name cap is for recurring syncs).
Usage: research/wrds/.venv/bin/python research/fair_value/s116_crsp.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wrds"))
from _auth import connect
from db import connect_local

OUT = Path(__file__).parent / "out"
with connect_local() as local:
    names = [r[0] for r in local.execute("SELECT DISTINCT key FROM vendor_raw WHERE source = 'sec' AND endpoint = 'companyfacts'").fetchall()]
tl = ",".join(repr(t.replace(".", "")) for t in names)
db = connect()
msf = db.raw_sql(f"""
WITH n AS (SELECT DISTINCT ON (ticker) ticker, permno FROM crsp.stocknames WHERE ticker IN ({tl}) ORDER BY ticker, nameenddt DESC)
SELECT n.ticker, m.date, ABS(m.prc) prc, m.ret, m.shrout, m.cfacpr FROM crsp.msf m JOIN n ON n.permno = m.permno WHERE m.date >= '2012-01-01'""")
msi = db.raw_sql("SELECT date, vwretd FROM crsp.msi WHERE date >= '2012-01-01'")
db.close()
msf.merge(msi, on="date", how="left").to_csv(OUT / "s116_crsp_msf.csv", index=False)
print(f"crsp msf: {len(msf)} rows, {msf.ticker.nunique()} names, {msf.date.min()} → {msf.date.max()}")
