import sys,json
sys.path.insert(0,'/Users/jamiepark/Cursor/fildi/scripts/watchlist_sync')
from build_plan import connect,rows
Q={
'gold_summary': """SELECT count(*) names, count(*) FILTER(WHERE pe_ratio IS NOT NULL) pe,
count(*) FILTER(WHERE earnings_per_share IS NOT NULL) eps,
count(*) FILTER(WHERE ev_ebitda>200 OR ev_ebitda<0) ev_outside_band,
count(*) FILTER(WHERE total_stockholders_equity<0) negative_equity
FROM ticker_fundamentals""",
'currency_derived': """WITH currency AS (SELECT DISTINCT ON(upper(key)) upper(key) ticker,
upper(payload->'financialData'->>'financialCurrency') fc FROM vendor_raw
WHERE source='yahoo' AND payload->'financialData'->>'financialCurrency' IS NOT NULL
ORDER BY upper(key),fetched_on DESC)
SELECT c.fc,fp.field,count(*) n, jsonb_agg(jsonb_build_object('ticker',fp.ticker,'value',fp.winning_value,'updated_at',fp.updated_at)) records FROM field_provenance fp JOIN currency c ON c.ticker=fp.ticker
JOIN ticker_fundamentals tf ON tf.ticker=fp.ticker
WHERE fp.winning_source='derived' AND fp.field IN ('peRatio','priceToSales','priceToBook','forwardPe','evEbitda','evRevenue')
AND c.fc<>'USD' AND CASE fp.field WHEN 'peRatio' THEN tf.pe_ratio WHEN 'priceToSales' THEN tf.price_to_sales
WHEN 'priceToBook' THEN tf.price_to_book WHEN 'forwardPe' THEN tf.forward_pe
WHEN 'evEbitda' THEN tf.ev_ebitda WHEN 'evRevenue' THEN tf.ev_revenue END IS NOT NULL
GROUP BY c.fc,fp.field ORDER BY c.fc,fp.field""",
'negative_equity': """SELECT count(*) FILTER(WHERE tf.debt_to_equity IS NOT NULL) de_leaks,
count(*) FILTER(WHERE tf.return_on_equity IS NOT NULL) roe_leaks FROM ticker_fundamentals tf
WHERE tf.total_stockholders_equity<0""",
}
with connect() as c:
 c.execute('SET TRANSACTION READ ONLY')
 c.execute("SET LOCAL statement_timeout='15s'")
 for label,q in Q.items():
  print(label,json.dumps(rows(c,q),default=str))
 c.rollback()
