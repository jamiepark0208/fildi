// bug/8: persisted to app_config (not scoring_config) so a restart mid-window
// doesn't lose the "already ran today" guard and cause a duplicate enrichment run.
export const LAST_ENRICHMENT_RUN_KEY = "last_enrichment_run";
export const LAST_RETENTION_PRUNE_KEY = "last_retention_prune";
export const LAST_TRADE_EXPIRY_RUN_KEY = "last_trade_expiry_run";
export const LAST_MODEL_SNAPSHOT_RUN_KEY = "last_model_snapshot_run";
export const LAST_OPTION_SCORE_RUN_KEY = "last_option_score_snapshot_run";
export const LAST_EVENT_BULLETS_RUN_KEY = "last_event_bullets_run";
export const LAST_EARNINGS_BACKFILL_RUN_KEY = "last_earnings_backfill_run";
export const LAST_FMP_ANALYST_FEED_RUN_KEY = "last_fmp_analyst_feed_run";
export const LAST_DESK_INGEST_RUN_KEY = "last_desk_commentary_ingest_run";
export const LAST_VOICES_INGEST_RUN_KEY = "last_voices_ingest_run";
export const LAST_SCHWAB_HEALTH_RUN_KEY = "last_schwab_health_run";
export const LAST_RESEARCH_OPS_RUN_KEY = "last_research_ops_health_run";
