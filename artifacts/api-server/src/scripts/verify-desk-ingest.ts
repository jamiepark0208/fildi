/**
 * Verify desk normalize against fixtures or a live Drive folder.
 *
 *   cd artifacts/api-server && npx tsx src/scripts/verify-desk-ingest.ts
 *   npx tsx src/scripts/verify-desk-ingest.ts --dir="$HOME/.../TradeDash Briefs" --limit=40
 *   npx tsx src/scripts/verify-desk-ingest.ts --write-goldens
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonSidecar } from "../lib/desk-commentary-parse.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIX = join(__dir, "../../fixtures/desk-emails");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = arg("--dir") ?? DEFAULT_FIX;
const limit = Number(arg("--limit") ?? 80);
const writeGoldens = process.argv.includes("--write-goldens");

if (!existsSync(dir)) {
  console.error("dir missing:", dir);
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".expected.json"))
  .sort()
  .slice(0, limit);

let fail = 0;
const rows: Array<Record<string, unknown>> = [];

for (const f of files) {
  const parsed = parseJsonSidecar(readFileSync(join(dir, f), "utf8"), f);
  if (!parsed) {
    console.error("PARSE FAIL", f);
    fail++;
    continue;
  }
  const summary = {
    file: f,
    source: parsed.source,
    kind: parsed.kind,
    category: parsed.category,
    noiseScore: parsed.noiseScore,
    includeInBrief: (parsed.meta as { includeInBrief?: boolean }).includeInBrief,
    noiseReasons: (parsed.meta as { noiseReasons?: string[] }).noiseReasons ?? [],
    fromDomain: parsed.fromDomain,
    subject: parsed.subject,
    contentLinks: ((parsed.meta as { contentLinks?: unknown[] }).contentLinks ?? []).length,
    tickers: parsed.tickersMentioned.slice(0, 8),
  };
  rows.push(summary);

  const goldenPath = join(dir, f.replace(/\.json$/, ".expected.json"));
  if (writeGoldens) {
    writeFileSync(goldenPath, JSON.stringify(summary, null, 2) + "\n");
    console.log("wrote", goldenPath);
  } else if (existsSync(goldenPath)) {
    const exp = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<string, unknown>;
    for (const k of ["source", "category", "includeInBrief"] as const) {
      if (exp[k] !== summary[k]) {
        console.error(`GOLDEN FAIL ${f} ${k}: got ${summary[k]} want ${exp[k]}`);
        fail++;
      }
    }
  }

  const flag = summary.includeInBrief ? "IN " : "OUT";
  console.log(
    `${flag} n=${String(summary.noiseScore).padStart(3)} ${(summary.category as string).padEnd(18)} ${(summary.source as string).padEnd(22)} ${summary.subject}`,
  );
}

console.log(`\n${files.length} files · ${rows.filter((r) => r.includeInBrief).length} included · fails=${fail}`);
process.exit(fail ? 1 : 0);
