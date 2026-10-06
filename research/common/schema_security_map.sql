-- Shared ID map for WRDS + LSEG research lanes.
-- Column ownership: LSEG writes ric/cusip/isin; WRDS writes ibes_oftic/crsp_permno.
-- Never overwrite the other lane's columns (use COALESCE in upserts).
-- Apply: psql "$DATABASE_URL" -f research/common/schema_security_map.sql

CREATE SCHEMA IF NOT EXISTS research_common;

CREATE TABLE IF NOT EXISTS research_common.security_map (
  ticker          text PRIMARY KEY,
  ric             text,
  cusip           text,
  isin            text,
  ibes_oftic      text,
  crsp_permno     integer,
  updated_by_lseg timestamptz,
  updated_by_wrds timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_research_security_map_cusip
  ON research_common.security_map (cusip)
  WHERE cusip IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_research_security_map_permno
  ON research_common.security_map (crsp_permno)
  WHERE crsp_permno IS NOT NULL;
