export type ChartPeriod = "1D" | "1W" | "1M" | "3M" | "1Y";

export type OhlcBar = {
  date: string;
  close: number;
  high?: number | null;
  low?: number | null;
};

/** Subset of ticker_technicals fields used for chart zones + IV band (A93) */
export type DbTechnicalLevels = {
  swingHigh20d?: string | number | null;
  swingLow20d?: string | number | null;
  swingHigh50d?: string | number | null;
  swingLow50d?: string | number | null;
  pivotS1?: string | number | null;
  pivotR1?: string | number | null;
  pivotPoint?: string | number | null;
  ma50?: string | number | null;
  ma200?: string | number | null;
  bbUpper?: string | number | null;
  bbLower?: string | number | null;
  vwap20d?: string | number | null;
  /** ATM put IV in percent (e.g. 35 = 35%). */
  atmPutIv?: string | number | null;
  /** Weekly implied move as fraction of spot (e.g. 0.06 = 6%). */
  impliedMoveWeekly?: string | number | null;
};

/**
 * A chart level is either a `marker` (exact bar/date where a period or swing
 * extreme occurred — rendered as a dot) or a `line` (a price level with no
 * single associated bar, e.g. a pivot/MA/BB value — rendered as a horizontal
 * price line). Levels fall back to `line` whenever no bar date is known,
 * which happens when a swing value comes from precomputed DB technicals
 * rather than the currently-loaded bars.
 */
export type ChartZone = {
  price: number;
  label: string;
  kind: "support" | "resistance";
  strength: number; // 0–1; higher = more significant level
  renderAs: "line" | "marker";
  date?: string;
};

const MERGE_PCT = 0.005;
const MAX_EACH = 2;

function strengthForLabel(label: string): number {
  if (label.startsWith("Pivot")) return 1.0;
  if (label === "MA200") return 0.95;
  if (label === "MA50") return 0.85;
  if (label.includes("50d")) return 0.80;
  if (label.includes("20d")) return 0.70;
  if (label.startsWith("BB")) return 0.65;
  return 0.55; // Period high/low
}

type Candidate = { price: number; label: string; kind: "support" | "resistance"; date?: string };

export function pfNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Local swing pivots on closes (±2-bar neighbors), same logic as technicals-db. Indices are absolute into `closes`. */
export function swingHighLow(
  closes: number[],
  lookback: number,
): { high: number | null; low: number | null; highIndex: number | null; lowIndex: number | null } {
  if (closes.length < lookback + 4) return { high: null, low: null, highIndex: null, lowIndex: null };
  const offset = closes.length - (lookback + 4);
  const slice = closes.slice(offset);
  let high: number | null = null;
  let low: number | null = null;
  let highIndex: number | null = null;
  let lowIndex: number | null = null;
  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    if (c > slice[i - 2] && c > slice[i + 2]) {
      if (high === null || c > high) { high = c; highIndex = offset + i; }
    }
    if (c < slice[i - 2] && c < slice[i + 2]) {
      if (low === null || c < low) { low = c; lowIndex = offset + i; }
    }
  }
  return { high, low, highIndex, lowIndex };
}

function addCandidate(list: Candidate[], price: number | null, label: string, kind: "support" | "resistance", date?: string) {
  if (price == null || !Number.isFinite(price)) return;
  list.push({ price, label, kind, date });
}

function maKind(price: number, current: number): "support" | "resistance" {
  return current >= price ? "support" : "resistance";
}

function mergeClose(candidates: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of candidates) {
    const dup = out.find(o => o.kind === c.kind && Math.abs(o.price - c.price) / c.price < MERGE_PCT);
    if (!dup) out.push(c);
  }
  return out;
}

/** Marker-eligible labels render as an exact-bar dot only when a bar date is known; otherwise they fall back to a price line. */
function renderAsFor(c: Candidate): "line" | "marker" {
  if (c.date && (
    c.label.startsWith("Period")
    || c.label.startsWith("Swing")
    || c.label.startsWith("Pivot")
  )) return "marker";
  return "line";
}

/** Bar date nearest the level — Pivot S1→low touch, Pivot R1→high touch, else closest close. */
function nearestBarDate(
  bars: OhlcBar[],
  price: number,
  kind: "support" | "resistance",
): string | undefined {
  if (bars.length === 0) return undefined;
  let best = bars[0]!;
  let bestDist = Infinity;
  for (const b of bars) {
    const ref = kind === "support" ? (b.low ?? b.close) : (b.high ?? b.close);
    const d = Math.abs(ref - price);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best.date;
}

function pickZones(
  candidates: Candidate[],
  currentPrice: number,
  yMin: number,
  yMax: number,
): ChartZone[] {
  const merged = mergeClose(candidates).filter(c => c.price >= yMin && c.price <= yMax);

  const supports = merged
    .filter(c => c.kind === "support")
    .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price))
    .slice(0, MAX_EACH);

  const resistances = merged
    .filter(c => c.kind === "resistance")
    .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price))
    .slice(0, MAX_EACH);

  return [...supports, ...resistances].map(c => ({
    price: c.price,
    label: c.label,
    kind: c.kind,
    strength: strengthForLabel(c.label),
    renderAs: renderAsFor(c),
    date: c.date,
  }));
}

export function computeChartZones(
  bars: OhlcBar[],
  period: ChartPeriod,
  db: DbTechnicalLevels | null | undefined,
): ChartZone[] {
  if (bars.length === 0) return [];

  const closes = bars.map(b => b.close);
  const currentPrice = closes[closes.length - 1];
  const yMin = Math.min(...closes) * 0.97;
  const yMax = Math.max(...closes) * 1.03;

  const d = {
    swingHigh20d: pfNum(db?.swingHigh20d),
    swingLow20d: pfNum(db?.swingLow20d),
    swingHigh50d: pfNum(db?.swingHigh50d),
    swingLow50d: pfNum(db?.swingLow50d),
    pivotS1: pfNum(db?.pivotS1),
    pivotR1: pfNum(db?.pivotR1),
    ma50: pfNum(db?.ma50),
    ma200: pfNum(db?.ma200),
    bbUpper: pfNum(db?.bbUpper),
    bbLower: pfNum(db?.bbLower),
    vwap20d: pfNum(db?.vwap20d),
  };

  const candidates: Candidate[] = [];
  const lb = (n: number) => Math.min(n, Math.max(4, closes.length - 5));
  const dateAt = (index: number | null) => (index != null ? bars[index]?.date : undefined);

  switch (period) {
    case "1D":
      if (d.pivotS1 != null) {
        addCandidate(candidates, d.pivotS1, "Pivot S1", "support", nearestBarDate(bars, d.pivotS1, "support"));
      }
      if (d.pivotR1 != null) {
        addCandidate(candidates, d.pivotR1, "Pivot R1", "resistance", nearestBarDate(bars, d.pivotR1, "resistance"));
      }
      if (closes.length >= 10) {
        const s = swingHighLow(closes, lb(20));
        addCandidate(candidates, s.low, "Swing low", "support", dateAt(s.lowIndex));
        addCandidate(candidates, s.high, "Swing high", "resistance", dateAt(s.highIndex));
      }
      break;

    case "1W": {
      const s = swingHighLow(closes, lb(7));
      addCandidate(candidates, s.low, "Swing low", "support", dateAt(s.lowIndex));
      addCandidate(candidates, s.high, "Swing high", "resistance", dateAt(s.highIndex));
      break;
    }

    case "1M": {
      const s = swingHighLow(closes, lb(20));
      addCandidate(candidates, s.low, "Swing low 20d", "support", dateAt(s.lowIndex));
      addCandidate(candidates, s.high, "Swing high 20d", "resistance", dateAt(s.highIndex));
      break;
    }

    case "3M": {
      const s = swingHighLow(closes, lb(20));
      // Prefer DB-computed values; fall back to live calculation (with an exact bar date) if DB is absent
      addCandidate(candidates, d.swingLow20d ?? s.low, "Swing low 20d", "support", d.swingLow20d != null ? undefined : dateAt(s.lowIndex));
      addCandidate(candidates, d.swingHigh20d ?? s.high, "Swing high 20d", "resistance", d.swingHigh20d != null ? undefined : dateAt(s.highIndex));
      if (d.ma50 != null) addCandidate(candidates, d.ma50, "MA50", maKind(d.ma50, currentPrice));
      break;
    }

    case "1Y": {
      const s20 = swingHighLow(closes, lb(20));
      const s50 = swingHighLow(closes, lb(50));
      // Prefer DB-computed values; fall back to live calculation (with an exact bar date) if DB is absent
      addCandidate(candidates, d.swingLow20d ?? s20.low, "Swing low 20d", "support", d.swingLow20d != null ? undefined : dateAt(s20.lowIndex));
      addCandidate(candidates, d.swingHigh20d ?? s20.high, "Swing high 20d", "resistance", d.swingHigh20d != null ? undefined : dateAt(s20.highIndex));
      addCandidate(candidates, d.swingLow50d ?? s50.low, "Swing low 50d", "support", d.swingLow50d != null ? undefined : dateAt(s50.lowIndex));
      addCandidate(candidates, d.swingHigh50d ?? s50.high, "Swing high 50d", "resistance", d.swingHigh50d != null ? undefined : dateAt(s50.highIndex));
      if (d.pivotS1 != null) {
        addCandidate(candidates, d.pivotS1, "Pivot S1", "support", nearestBarDate(bars, d.pivotS1, "support"));
      }
      if (d.pivotR1 != null) {
        addCandidate(candidates, d.pivotR1, "Pivot R1", "resistance", nearestBarDate(bars, d.pivotR1, "resistance"));
      }
      addCandidate(candidates, d.bbLower, "BB lower", "support");
      addCandidate(candidates, d.bbUpper, "BB upper", "resistance");
      if (d.ma50 != null) addCandidate(candidates, d.ma50, "MA50", maKind(d.ma50, currentPrice));
      if (d.ma200 != null) addCandidate(candidates, d.ma200, "MA200", maKind(d.ma200, currentPrice));
      break;
    }
  }

  return pickZones(candidates, currentPrice, yMin, yMax);
}
