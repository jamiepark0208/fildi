/**
 * Fill ticker_registry.name from stored SEC submissions (vendor_raw) where it is missing or just the ticker.
 * Registry rows are created without a name (enrich-and-merge), so Rankings showed "MU MU" for ~1,050 names (11-15).
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const SUFFIX: Record<string, string> = { INC: "Inc", CORP: "Corp", CO: "Co", LTD: "Ltd", PLC: "plc", LLC: "LLC", LP: "LP", NV: "NV", SA: "SA", AG: "AG", SE: "SE", ETF: "ETF", REIT: "REIT", USA: "USA" };

/** "DUKE ENERGY CORP /DE/" → "Duke Energy Corp"; keeps mixed-case words (TransDigm) and short acronyms (AMD, J M). */
export function cleanSecName(raw: string): string {
  const base = raw.replace(/\s*\/[A-Z]{2,}\/?\s*$/, "").trim();
  return base.split(/(\s+)/).map((w) => {
    const core = w.replace(/[^A-Za-z]/g, "");
    if (!core || core !== core.toUpperCase()) return w;           // whitespace, numbers, or already mixed case
    if (SUFFIX[core]) return w.replace(core, SUFFIX[core]);
    if (core.length <= 3) return w;                                // likely an acronym (AMD, IBM, J)
    return w.replace(core, core[0] + core.slice(1).toLowerCase());
  }).join("");
}

export async function fillRegistryNames(): Promise<number> {
  const res = await db.execute(sql`
    SELECT DISTINCT ON (upper(v.key)) r.ticker, v.payload->>'name' AS name
    FROM ticker_registry r
    JOIN vendor_raw v ON v.source = 'sec' AND v.endpoint = 'submissions' AND upper(v.key) = upper(r.ticker)
    WHERE (r.name IS NULL OR btrim(r.name) = '' OR upper(r.name) = upper(r.ticker)) AND coalesce(v.payload->>'name', '') <> ''
    ORDER BY upper(v.key), v.fetched_on DESC`);
  const rows = (res as unknown as { rows: { ticker: string; name: string }[] }).rows ?? [];
  let n = 0;
  for (const r of rows) {
    const name = cleanSecName(r.name);
    if (!name) continue;
    await db.execute(sql`UPDATE ticker_registry SET name = ${name} WHERE ticker = ${r.ticker}`);
    n++;
  }
  return n;
}
