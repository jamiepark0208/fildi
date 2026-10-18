-- A148: per-ticker scoring-mode override so a ticker can move peer group but keep a mode
-- (ZTO/TCOM → industry groups, keep the "chinese" lens). NULL = use the group's mode.
ALTER TABLE "peer_group_overrides" ADD COLUMN IF NOT EXISTS "scoring_mode" text;
