export type ChartPeriod = "1D" | "1W" | "1M" | "3M" | "1Y";

export type OhlcBar = {
  date: string;
  close: number;
  high?: number | null;
  low?: number | null;
};

/** Subset of ticker_technicals fields used for chart zones */
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
};

export type ChartZone = {
  price: number;
  label: string;
  kind: "support" | "resistance";
  bandPct: number;
};

const DEFAULT_BAND = 0.004;
const MERGE_PCT = 0.005;
const MAX_EACH = 2;

type Candidate = { price: number; label: string; kind: "support" | "resistance" };

export function pfNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Local swing pivots on closes (±2-bar neighbors), same logic as technicals-db */
export function swingHighLow(closes: number[], lookback: number): { high: number | null; low: number | null } {
  if (closes.length < lookback + 4) return { high: null, low: null };
  const slice = closes.slice(-(lookback + 4));
  let high: number | null = null;
  let low: number | null = null;
  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    if (c > slice[i - 2] && c > slice[i + 2]) {
      if (high === null || c > high) high = c;
    }
    if (c < slice[i - 2] && c < slice[i + 2]) {
      if (low === null || c < low) low = c;
    }
  }
  return { high, low };
}

function periodExtrema(bars: OhlcBar[]): { high: number | null; low: number | null } {
  if (!bars.length) return { high: null, low: null };
  const highs = bars.map(b => b.high ?? b.close).filter(v => Number.isFinite(v));
  const lows = bars.map(b => b.low ?? b.close).filter(v => Number.isFinite(v));
  if (!highs.length || !lows.length) return { high: null, low: null };
  return { high: Math.max(...highs), low: Math.min(...lows) };
}

function addCandidate(list: Candidate[], price: number | null, label: string, kind: "support" | "resistance") {
  if (price == null || !Number.isFinite(price)) return;
  list.push({ price, label, kind });
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
    bandPct: DEFAULT_BAND,
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
  const { high: periodHigh, low: periodLow } = periodExtrema(bars);
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

  switch (period) {
    case "1D":
      addCandidate(candidates, periodLow, "Period low", "support");
      addCandidate(candidates, periodHigh, "Period high", "resistance");
      addCandidate(candidates, d.pivotS1, "Pivot S1", "support");
      addCandidate(candidates, d.pivotR1, "Pivot R1", "resistance");
      if (closes.length >= 10) {
        const s = swingHighLow(closes, lb(20));
        addCandidate(candidates, s.low, "Swing low", "support");
        addCandidate(candidates, s.high, "Swing high", "resistance");
      }
      break;

    case "1W": {
      addCandidate(candidates, periodLow, "Period low", "support");
      addCandidate(candidates, periodHigh, "Period high", "resistance");
      const s = swingHighLow(closes, lb(7));
      addCandidate(candidates, s.low, "Swing low", "support");
      addCandidate(candidates, s.high, "Swing high", "resistance");
      break;
    }

    case "1M": {
      addCandidate(candidates, periodLow, "Period low", "support");
      addCandidate(candidates, periodHigh, "Period high", "resistance");
      const s = swingHighLow(closes, lb(20));
      addCandidate(candidates, s.low, "Swing low 20d", "support");
      addCandidate(candidates, s.high, "Swing high 20d", "resistance");
      break;
    }

    case "3M": {
      const s = swingHighLow(closes, lb(20));
      addCandidate(candidates, s.low, "Swing low 20d", "support");
      addCandidate(candidates, s.high, "Swing high 20d", "resistance");
      addCandidate(candidates, d.swingLow20d, "Swing low 20d (DB)", "support");
      addCandidate(candidates, d.swingHigh20d, "Swing high 20d (DB)", "resistance");
      if (d.ma50 != null) addCandidate(candidates, d.ma50, "MA50", maKind(d.ma50, currentPrice));
      break;
    }

    case "1Y": {
      const s20 = swingHighLow(closes, lb(20));
      const s50 = swingHighLow(closes, lb(50));
      addCandidate(candidates, s20.low, "Swing low 20d", "support");
      addCandidate(candidates, s20.high, "Swing high 20d", "resistance");
      addCandidate(candidates, s50.low, "Swing low 50d", "support");
      addCandidate(candidates, s50.high, "Swing high 50d", "resistance");
      addCandidate(candidates, d.swingLow20d, "Swing low 20d (DB)", "support");
      addCandidate(candidates, d.swingHigh20d, "Swing high 20d (DB)", "resistance");
      addCandidate(candidates, d.swingLow50d, "Swing low 50d (DB)", "support");
      addCandidate(candidates, d.swingHigh50d, "Swing high 50d (DB)", "resistance");
      addCandidate(candidates, d.pivotS1, "Pivot S1", "support");
      addCandidate(candidates, d.pivotR1, "Pivot R1", "resistance");
      addCandidate(candidates, d.bbLower, "BB lower", "support");
      addCandidate(candidates, d.bbUpper, "BB upper", "resistance");
      if (d.ma50 != null) addCandidate(candidates, d.ma50, "MA50", maKind(d.ma50, currentPrice));
      if (d.ma200 != null) addCandidate(candidates, d.ma200, "MA200", maKind(d.ma200, currentPrice));
      break;
    }
  }

  return pickZones(candidates, currentPrice, yMin, yMax);
}

export function zoneYBounds(zone: ChartZone): { y1: number; y2: number } {
  return {
    y1: zone.price * (1 - zone.bandPct),
    y2: zone.price * (1 + zone.bandPct),
  };
}
