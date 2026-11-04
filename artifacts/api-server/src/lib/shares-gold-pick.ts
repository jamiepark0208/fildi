/** A329 seg3 — Yahoo mostRecentQuarter → ISO date (gold EPS period for the audit). */

export function parseYahooMostRecentQuarter(raw: string | null | undefined): string | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  const n = Number(s);
  if (Number.isFinite(n) && n > 1e8) {
    return new Date(n * (n > 1e12 ? 1 : 1000)).toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}
