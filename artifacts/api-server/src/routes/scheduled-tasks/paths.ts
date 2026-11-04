import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
export const LOG_DIR = "/tmp/fildi-logs";
export const LAUNCH_AGENTS = join(homedir(), "Library/LaunchAgents");
export const RBH_LOG = join(homedir(), "rbh_scripts/logs/daily_export.log");
export const RBH_LAST = join(homedir(), "rbh_scripts/logs/last_run.json");
export const RBH_SCRIPT = join(homedir(), "rbh_scripts/daily_export.sh");
export const RBH_EXPORT_PROMPT_LAST = join(homedir(), "rbh_scripts/logs/export_prompt_last.json");
/** PM jobs (Claude, PM role): each writes {ts, ok, detail} after a run. */
export const PM_ALERTS_LAST = "/tmp/fildi-logs/pm-alerts-last.json";
export const TRANSCRIPTS_LAST = "/tmp/fildi-logs/transcripts-last.json";
export const OPENJEV_LAST = "/tmp/fildi-logs/openjev-last.json";
export const PM_PY = join(ROOT, "scripts/watchlist_sync/.venv/bin/python");
