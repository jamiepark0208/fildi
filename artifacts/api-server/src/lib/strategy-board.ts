/** A368 — parse research/studies/BOARD.md. No scoring. */

export interface WorkRow {
  rule: string;
  number: string;
  study: string;
  live: string;
}

export interface DeadRow {
  idea: string;
  why: string;
  study: string;
}

export interface StrategyBoard {
  works: WorkRow[];
  underpowered: WorkRow[];
  dead: DeadRow[];
  testing: string[];
}

export interface S159Chip {
  tone: "fire" | "near" | "underpowered";
  text: string;
}

function cells(line: string): string[] {
  return line.split("|").slice(1, -1).map((c) => c.trim());
}

function tableRows(section: string): string[][] {
  const out: string[][] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const c = cells(line);
    if (c.length < 2 || c.every((x) => /^-+$/.test(x))) continue;
    if (/^rule$|^idea$/i.test(c[0])) continue;
    out.push(c);
  }
  return out;
}

export function parseBoard(md: string): StrategyBoard {
  const head = md.split("## Low N_eff")[0] ?? md;
  const underMd = md.includes("## Low N_eff") ? (md.split("## Low N_eff")[1]?.split("## Dead")[0] ?? "") : "";
  const rest = md.split("## Dead")[1] ?? "";
  const worksMd = head.split("## Dead")[0] ?? head;
  const deadMd = rest.split("## Testing")[0] ?? "";
  const testingMd = rest.split("## Testing")[1] ?? "";
  const works = tableRows(worksMd).map((c) => ({
    rule: c[0] ?? "",
    number: c[1] ?? "",
    study: c[2] ?? "",
    live: c[3] ?? "",
  }));
  const underpowered = tableRows(underMd).map((c) => ({
    rule: c[0] ?? "",
    number: c[1] ?? "",
    study: c[2] ?? "",
    live: c[3] ?? "",
  }));
  const dead = tableRows(deadMd).map((c) => ({
    idea: c[0] ?? "",
    why: c[1] ?? "",
    study: c[2] ?? "",
  }));
  const testing = testingMd
    .split("\n")
    .map((l) => l.replace(/^- /, "").trim())
    .filter((l) => l.startsWith("S") || l.startsWith("A") || l.startsWith("Candidates"));
  return { works, underpowered, dead, testing };
}

/** Last close RSI(14), Wilder. `closes` oldest first. */
export function rsi14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= 14;
  loss /= 14;
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * 13 + Math.max(d, 0)) / 14;
    loss = (loss * 13 + Math.max(-d, 0)) / 14;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Chip from already-computed RSI. QQQ 24 fires. Under 28 and not under 25 is "near". */
export function s159Chip(spy: number | null, qqq: number | null): S159Chip | null {
  const pts = [
    qqq != null && Number.isFinite(qqq) ? { name: "QQQ", rsi: qqq } : null,
    spy != null && Number.isFinite(spy) ? { name: "SPY", rsi: spy } : null,
  ].filter((p): p is { name: string; rsi: number } => p != null);
  if (pts.length === 0) return null;
  pts.sort((a, b) => a.rsi - b.rsi);
  const low = pts[0];
  const n = low.rsi.toFixed(1);
  if (low.rsi < 25) {
    return { tone: "fire", text: `${low.name} RSI ${n} — S159 oversold (5 d up; underpowered study, n≈17)` };
  }
  if (low.rsi < 28) {
    return { tone: "near", text: `${low.name} RSI ${n} — near S159 (underpowered; fires under 25)` };
  }
  return null;
}
