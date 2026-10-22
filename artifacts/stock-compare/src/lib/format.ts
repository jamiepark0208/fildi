export function formatCurrency(value?: number | null) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value?: number | null, decimals = 2) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatPercent(value?: number | null) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * YoY growth stored as fraction (0.15 = 15%, 49.6 = ≈50×).
 * Avoids "4,962%" on tiny-base names.
 */
export function formatGrowthYoY(value?: number | null) {
  if (value === null || value === undefined) return "-";
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 2) {
    const x = Math.abs(value);
    return `${value < 0 ? "−" : ""}≈${x.toFixed(x >= 10 ? 0 : 1)}×`;
  }
  return formatPercent(value);
}

export function formatLargeNumber(value?: number | null) {
  if (value === null || value === undefined) return "-";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  return formatCurrency(value);
}

// Compact axis label, e.g. $14.5K / -$2.3M — for chart ticks, not tooltips.
export function formatCompactCurrency(value?: number | null) {
  if (value === null || value === undefined) return "-";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Whole-number compact axis label ($15K / -$2M) — no decimals. */
export function formatCompactCurrencyInt(value?: number | null) {
  if (value === null || value === undefined) return "-";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${Math.round(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}$${Math.round(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}$${Math.round(abs / 1e3)}K`;
  return `${sign}$${Math.round(abs)}`;
}

/** Option expiry / near-term dates — m/d (no year). */
export function formatMd(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = String(iso).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [, m, d] = s.slice(0, 10).split("-");
    return `${Number(m)}/${Number(d)}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Display dates as m/d/yy (e.g. 9/12/26).
 * Date-only YYYY-MM-DD stays calendar (no TZ). Timestamps use America/Los_Angeles
 * so evening PT imports don't flip to the next UTC calendar day.
 */
export function formatMdYy(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = String(iso).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-");
    return `${Number(m)}/${Number(d)}/${y!.slice(2)}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${Number(get("month"))}/${Number(get("day"))}/${get("year")}`;
}

/** Chart x-axis: m/yy (e.g. 10/26). Uses leading YYYY-MM from day-bucket keys. */
export function formatMYy(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = String(iso).trim();
  const m = /^(\d{4})-(\d{2})/.exec(s);
  if (m) return `${Number(m[2])}/${m[1]!.slice(2)}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`;
}
