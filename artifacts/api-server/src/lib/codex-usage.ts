import { codexSessionRecords } from "./codex-session-records.js";

// Read only bounded tails, return numeric telemetry. Never expose transcript content.
export function parseCodexUsage(text: string, now = Date.now()) {
  let latest: { at: string; stale: boolean; windows: { minutes: number; used: number; resetsAt: string }[] } | null = null;
  for (const line of text.split("\n")) {
    try {
      const row = JSON.parse(line);
      if (row.type !== "event_msg" || row.payload?.type !== "token_count") continue;
      const limits = row.payload.rate_limits;
      const at = Date.parse(row.timestamp);
      if (!limits || limits.limit_id !== "codex" || !Number.isFinite(at) || at > now || (latest && at <= Date.parse(latest.at))) continue;
      const windows = [limits.primary, limits.secondary].flatMap(w => {
        if (!w || !Number.isFinite(w.used_percent) || !Number.isFinite(w.window_minutes) || w.window_minutes <= 0 || !Number.isFinite(w.resets_at)) return [];
        return [{ minutes: w.window_minutes, used: Math.min(100, Math.max(0, w.used_percent)), resetsAt: new Date(w.resets_at * 1000).toISOString() }];
      });
      if (windows.length) latest = { at: new Date(at).toISOString(), stale: now - at > 15 * 60_000 || windows.some(w => Date.parse(w.resetsAt) <= now), windows };
    } catch { /* partial tail or malformed record */ }
  }
  return latest;
}
export function codexUsage(now = Date.now(), root?: string) {
  let value: ReturnType<typeof parseCodexUsage> = null;
  for (const row of codexSessionRecords(now,root)) {
    const parsed = parseCodexUsage(row.tail,now);
    if (parsed && (!value || parsed.at > value.at)) value = parsed;
  }
  return value;
}
