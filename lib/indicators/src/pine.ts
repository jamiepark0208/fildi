/**
 * Pine Script primitives, exact to TradingView semantics (Jamie 11-04 port spec).
 * Series are plain number[] aligned to bars; `NaN` is Pine's `na`. Every function at index i reads only indices <= i
 * (pivots report at the confirming bar), so nothing here can look ahead.
 */
export type Series = number[];

const na = Number.NaN;
export const isNa = (x: number): boolean => Number.isNaN(x);
/** Pine nz(x, d). */
export const nz = (x: number, d = 0): number => (Number.isNaN(x) ? d : x);

const blank = (n: number): Series => new Array<number>(n).fill(na);

/** ta.sma — na until `n` consecutive non-na values exist. */
export function sma(src: Series, n: number): Series {
  const out = blank(src.length);
  for (let i = n - 1; i < src.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = i - n + 1; k <= i; k++) {
      const v = src[k]!;
      if (Number.isNaN(v)) { ok = false; break; }
      s += v;
    }
    if (ok) out[i] = s / n;
  }
  return out;
}

/** ta.ema — seed = sma of the first n valid values (Pine: `na(prev) ? sma(src, n) : alpha*src + (1-alpha)*prev`). */
export function ema(src: Series, n: number): Series {
  const out = blank(src.length);
  const alpha = 2 / (n + 1);
  for (let i = 0; i < src.length; i++) {
    const prev = i ? out[i - 1]! : na;
    if (Number.isNaN(prev)) {
      if (i >= n - 1) {
        let s = 0;
        let ok = true;
        for (let k = i - n + 1; k <= i; k++) {
          const v = src[k]!;
          if (Number.isNaN(v)) { ok = false; break; }
          s += v;
        }
        if (ok) out[i] = s / n;
      }
    } else {
      out[i] = alpha * src[i]! + (1 - alpha) * prev;
    }
  }
  return out;
}

/** ta.rma — Wilder smoothing, alpha 1/n, same sma seed. */
export function rma(src: Series, n: number): Series {
  const out = blank(src.length);
  const alpha = 1 / n;
  for (let i = 0; i < src.length; i++) {
    const prev = i ? out[i - 1]! : na;
    if (Number.isNaN(prev)) {
      if (i >= n - 1) {
        let s = 0;
        let ok = true;
        for (let k = i - n + 1; k <= i; k++) {
          const v = src[k]!;
          if (Number.isNaN(v)) { ok = false; break; }
          s += v;
        }
        if (ok) out[i] = s / n;
      }
    } else {
      out[i] = alpha * src[i]! + (1 - alpha) * prev;
    }
  }
  return out;
}

/** ta.stdev(src, n) — biased (population) by default, like Pine. */
export function stdev(src: Series, n: number, biased = true): Series {
  const out = blank(src.length);
  for (let i = n - 1; i < src.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = i - n + 1; k <= i; k++) {
      const v = src[k]!;
      if (Number.isNaN(v)) { ok = false; break; }
      s += v;
    }
    if (!ok) continue;
    const mean = s / n;
    let ss = 0;
    for (let k = i - n + 1; k <= i; k++) ss += (src[k]! - mean) ** 2;
    out[i] = Math.sqrt(ss / (biased ? n : n - 1));
  }
  return out;
}

/** ta.linreg(src, n, offset) — least-squares line over the last n bars, value at (n-1-offset). */
export function linreg(src: Series, n: number, offset = 0): Series {
  const out = blank(src.length);
  const sx = (n * (n - 1)) / 2;
  const sxx = ((n - 1) * n * (2 * n - 1)) / 6;
  const den = n * sxx - sx * sx;
  for (let i = n - 1; i < src.length; i++) {
    let sy = 0, sxy = 0;
    let ok = true;
    for (let k = 0; k < n; k++) {
      const y = src[i - n + 1 + k]!;
      if (Number.isNaN(y)) { ok = false; break; }
      sy += y;
      sxy += k * y;
    }
    if (!ok) continue;
    const slope = n === 1 ? 0 : (n * sxy - sx * sy) / den;
    const intercept = (sy - slope * sx) / n;
    out[i] = intercept + slope * (n - 1 - offset);
  }
  return out;
}

/** ta.highest(src, n). */
export function highest(src: Series, n: number): Series {
  const out = blank(src.length);
  for (let i = n - 1; i < src.length; i++) {
    let m = -Infinity;
    let ok = true;
    for (let k = i - n + 1; k <= i; k++) {
      const v = src[k]!;
      if (Number.isNaN(v)) { ok = false; break; }
      if (v > m) m = v;
    }
    if (ok) out[i] = m;
  }
  return out;
}

/** ta.lowest(src, n). */
export function lowest(src: Series, n: number): Series {
  const out = blank(src.length);
  for (let i = n - 1; i < src.length; i++) {
    let m = Infinity;
    let ok = true;
    for (let k = i - n + 1; k <= i; k++) {
      const v = src[k]!;
      if (Number.isNaN(v)) { ok = false; break; }
      if (v < m) m = v;
    }
    if (ok) out[i] = m;
  }
  return out;
}

/** ta.change(src, n) = src - src[n]. */
export function change(src: Series, n = 1): Series {
  const out = blank(src.length);
  for (let i = n; i < src.length; i++) out[i] = src[i]! - src[i - n]!;
  return out;
}

/**
 * ta.tr (handle_na = false, the `tr` built-in): na on the first bar, then
 * max(high-low, |high-close[1]|, |low-close[1]|).
 */
export function tr(high: Series, low: Series, close: Series): Series {
  const out = blank(high.length);
  for (let i = 1; i < high.length; i++) {
    out[i] = Math.max(high[i]! - low[i]!, Math.abs(high[i]! - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!));
  }
  return out;
}

/** ta.crossover(a, b) at bar i: a > b and a[1] <= b[1]. Any na operand → false. */
export function crossover(a: Series, b: Series, i: number): boolean {
  if (i < 1) return false;
  return a[i]! > b[i]! && a[i - 1]! <= b[i - 1]!;
}

/** ta.crossunder(a, b) at bar i: a < b and a[1] >= b[1]. */
export function crossunder(a: Series, b: Series, i: number): boolean {
  if (i < 1) return false;
  return a[i]! < b[i]! && a[i - 1]! >= b[i - 1]!;
}

function pivot(src: Series, left: number, right: number, sign: 1 | -1): Series {
  const out = blank(src.length);
  for (let i = left + right; i < src.length; i++) {
    const c = src[i - right]!;
    if (Number.isNaN(c)) continue;
    let ok = true;
    for (let k = i - right - left; k <= i; k++) {
      const v = src[k]!;
      if (Number.isNaN(v) || (sign > 0 ? v > c : v < c)) { ok = false; break; }
    }
    if (ok) out[i] = c;
  }
  return out;
}

/**
 * ta.pivothigh(src, left, right): at bar i returns the pivot value src[i-right] (known `right` bars late), else na.
 * Ties with the centre bar do not disqualify it. The pivot bar is i - right.
 */
export const pivothigh = (src: Series, left: number, right: number): Series => pivot(src, left, right, 1);
/** ta.pivotlow — see pivothigh. */
export const pivotlow = (src: Series, left: number, right: number): Series => pivot(src, left, right, -1);

/** Pine src[k] at bar i (na when out of range). */
export const at = (src: Series, i: number, k = 0): number => (i - k >= 0 ? src[i - k]! : na);

/** Pine ta.rsi. */
export function rsi(src: Series, n: number): Series {
  const up = blank(src.length);
  const dn = blank(src.length);
  for (let i = 1; i < src.length; i++) {
    const d = src[i]! - src[i - 1]!;
    up[i] = Math.max(d, 0);
    dn[i] = Math.max(-d, 0);
  }
  const u = rma(up, n);
  const d = rma(dn, n);
  return u.map((x, i) => (Number.isNaN(x) || Number.isNaN(d[i]!) ? na : d[i] === 0 ? 100 : x === 0 ? 0 : 100 - 100 / (1 + x / d[i]!)));
}
