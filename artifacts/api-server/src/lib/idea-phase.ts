/** Ideas board column. A row waiting on another agent is Inbox, not Ready or In progress. */

export function ideaPhase(status: string): string {
  const raw = status.trim();
  const s = raw.toLowerCase();
  if (s.startsWith("verified")) return "verified";
  if (s.startsWith("done")) return "done";
  if (s.startsWith("declined") || s.startsWith("deferred") || s.startsWith("parked")) return "parked";
  if (/\bSTOP\b/.test(raw) || /\bstop:\s*no build\b/i.test(raw) || /\bstop:\s*no library\b/i.test(raw)) return "parked";
  const blocked = /needs claude|needs cursor|\brevise\b/i.test(raw);
  if (s.startsWith("accepted") || s.startsWith("partial")) return blocked ? "filed" : "building";
  if (s.startsWith("planned")) return blocked ? "filed" : "reviewed";
  if (/needs jamie|user call/.test(s)) return "needs you";
  return "filed";
}
