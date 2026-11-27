"""Bounded, read-only recommendation/evidence/accountability audit. No vendors or model calls."""
import hashlib,json,time
from pathlib import Path
import psycopg
from psycopg.rows import dict_row
from dotenv import dotenv_values
ROOT=Path(__file__).resolve().parents[3]
Q={
 'clock':'SELECT current_timestamp captured_at,current_date db_date',
 'backtests':"SELECT structure,as_of,updated_at,payload->>'verdict' verdict,payload->>'why' why,payload->>'method' method,payload->'as_shown' summary FROM watchlist_sync.structure_backtest ORDER BY structure",
 'catalog':"SELECT id,evidence,evidence_note FROM watchlist_sync.structure_catalog ORDER BY id",
 'board_dates':"SELECT as_of,count(*) n,count(distinct structure) structures FROM watchlist_sync.structure_rank_daily GROUP BY as_of ORDER BY as_of DESC LIMIT 5",
 'board_tiers':"SELECT structure,coalesce(payload->>'tier','primary') tier,count(*) n,min((payload->>'dte')::numeric) min_dte,max((payload->>'dte')::numeric) max_dte FROM watchlist_sync.structure_rank_daily WHERE as_of=(SELECT max(as_of) FROM watchlist_sync.structure_rank_daily) GROUP BY 1,2 ORDER BY 1,2",
 'board_samples':"SELECT structure,ticker,payload FROM watchlist_sync.structure_rank_daily WHERE as_of=(SELECT max(as_of) FROM watchlist_sync.structure_rank_daily) AND rank=1 ORDER BY structure",
 'forecast_coverage':"SELECT qtype,forecaster,count(*) n,count(distinct question_id) questions,count(*) FILTER(WHERE outcome IS NOT NULL) resolved,count(*) FILTER(WHERE outcome IS NULL AND resolves_on<current_date) overdue,min(made_on) first_made,max(made_on) last_made,max(resolved_at) last_resolved FROM watchlist_sync.forecast_ledger GROUP BY 1,2 ORDER BY 1,2",
 'structure_resolution':"SELECT meta->>'structure' structure,forecaster,count(*) n,count(*) FILTER(WHERE outcome IS NOT NULL) resolved,count(*) FILTER(WHERE outcome IS NULL AND resolves_on<current_date) overdue,count(distinct resolves_on) expiries,count(distinct resolves_on) FILTER(WHERE outcome IS NOT NULL) resolved_expiries,avg(prob) FILTER(WHERE outcome IS NOT NULL) predicted,avg(outcome::int) realized,avg(power(prob-outcome::int,2)) brier,min(made_on) first_made,max(made_on) last_made FROM watchlist_sync.forecast_ledger WHERE question_id LIKE 'struct:%' GROUP BY 1,2 ORDER BY 1,2",
 'board_ledger_coverage':"SELECT b.as_of,count(*) board_rows,count(*) FILTER(WHERE coalesce(b.payload->>'tier','primary')='primary') primary_rows,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM watchlist_sync.forecast_ledger f WHERE f.question_id='struct:'||b.structure||':'||b.ticker||':'||(b.payload->>'expiry')||':'||b.as_of::text)) ledgered_rows FROM watchlist_sync.structure_rank_daily b WHERE b.as_of>=current_date-14 GROUP BY 1 ORDER BY 1 DESC",
 'runs':"SELECT id,created_at,model_version,fit_run_at FROM watchlist_sync.model_runs ORDER BY id DESC LIMIT 3",
 'current_items':"SELECT folder_key,status,count(*) n FROM watchlist_sync.model_items WHERE run_id=(SELECT max(id) FROM watchlist_sync.model_runs) GROUP BY 1,2 ORDER BY 1,2",
 'latest_option_items':"SELECT ticker,folder_key,status,contract-'account' contract FROM watchlist_sync.model_items WHERE run_id=(SELECT max(id) FROM watchlist_sync.model_runs) AND folder_key IN ('sell_puts','sell_calls','rich_puts','review') ORDER BY folder_key,rank",
 'grades':"SELECT folder_key,horizon,count(*) n,count(distinct run_id) runs,min(graded_at) first_grade,max(graded_at) latest_grade,avg(ret) mean_ret,count(*) FILTER(WHERE bucket='factor') factor_cases FROM watchlist_sync.grades GROUP BY 1,2 ORDER BY 1,2",
 'model_grade_age':"SELECT r.created_at::date run_day,i.folder_key,count(*) items,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM watchlist_sync.grades g WHERE g.run_id=i.run_id AND g.folder_key=i.folder_key AND g.ticker=i.ticker)) any_grade FROM watchlist_sync.model_items i JOIN watchlist_sync.model_runs r ON r.id=i.run_id WHERE r.created_at::date>=current_date-30 GROUP BY 1,2 ORDER BY 1 DESC,2",
 'recs_status':"SELECT side,status,count(*) n,count(*) FILTER(WHERE expiry<current_date AND graded_at IS NULL) overdue,min(snapshot_date) first_day,max(snapshot_date) last_day,max(graded_at) latest_grade FROM model_recs GROUP BY 1,2 ORDER BY 1,2",
 'scoreboard':"SELECT item,source,promised,live,n,verdict,checked_at,check_key FROM watchlist_sync.scoreboard ORDER BY item",
 'strategies':"SELECT strategy_id,version,name,status,study_ref,window_start,window_end,holdout_start,price_source,updated_at FROM watchlist_sync.strategies ORDER BY updated_at DESC",
 'strategy_coverage':"SELECT strategy_id,version,count(*) n,min(entry_ts) first_entry,max(entry_ts) last_entry,count(*) FILTER(WHERE exit_ts IS NOT NULL) closed,count(*) FILTER(WHERE is_holdout) holdout FROM watchlist_sync.strategy_trades GROUP BY 1,2 ORDER BY 1,2",
 'learning_versions':"SELECT version,status,created_at,promoted_at,params->'learning' learning FROM watchlist_sync.model_params ORDER BY created_at DESC LIMIT 6",
 'learning_cells':"SELECT as_of,count(*) cells,count(*) FILTER(WHERE demote) demoted FROM watchlist_sync.rec_cells GROUP BY 1 ORDER BY 1 DESC LIMIT 3",
 'today_structure_ledger':"SELECT question_id,subject,meta->>'structure' structure,forecaster,made_on FROM watchlist_sync.forecast_ledger WHERE question_id LIKE 'struct:%' AND made_on=current_date ORDER BY question_id,forecaster",
 'structure_unique_contracts':"WITH keyed AS (SELECT *, (SELECT jsonb_agg(jsonb_build_array(l->>'side',l->>'strike',l->>'expiry',l->>'qty') ORDER BY l->>'expiry',l->>'side',l->>'strike',l->>'qty') FROM jsonb_array_elements(meta->'legs') l) contract_key FROM watchlist_sync.forecast_ledger WHERE question_id LIKE 'struct:%' AND outcome IS NOT NULL), first_issued AS (SELECT DISTINCT ON (meta->>'structure',subject,resolves_on,contract_key,forecaster) meta->>'structure' structure,subject,resolves_on,forecaster,prob,outcome FROM keyed ORDER BY meta->>'structure',subject,resolves_on,contract_key,forecaster,made_at) SELECT structure,forecaster,count(*) n,count(distinct resolves_on) expiries,avg(prob) predicted,avg(outcome::int) realized FROM first_issued GROUP BY 1,2 ORDER BY 1,2",
}
out={'scope':'Read-only stored recommendation evidence; aggregate outcomes are descriptive, not a fresh strategy backtest.','checks':{}}
start=time.monotonic()
with psycopg.connect(dotenv_values(ROOT/'.env.local')['DATABASE_URL'],connect_timeout=5,row_factory=dict_row) as c:
 c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
 c.execute("SET LOCAL statement_timeout='15s'")
 for name,q in Q.items():
  if time.monotonic()-start>90:raise RuntimeError('Audit deadline')
  out['checks'][name]=c.execute(q).fetchall()
out['elapsed_seconds']=time.monotonic()-start
paths=['scripts/watchlist_sync/structures.py','scripts/watchlist_sync/forecast_ledger.py','scripts/watchlist_sync/grade_ledger.py','scripts/watchlist_sync/analysis/s076_structures_backtest.py','artifacts/api-server/src/lib/structures/rank.ts','artifacts/api-server/src/lib/structures/evidence-map.ts','artifacts/stock-compare/src/components/options-structures/structure-desk.ts','artifacts/stock-compare/src/components/options-structures/StructureLab.tsx']
out['source_hashes']={p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in paths}
target=Path(__file__).with_name('2026-11-24-structures-evidence.json')
target.write_text(json.dumps(out,default=str,indent=2)+'\n')
print(json.dumps({'queries':len(Q),'seconds':out['elapsed_seconds'],'counts':{k:len(v) for k,v in out['checks'].items()}}))
