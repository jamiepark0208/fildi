/** Indicators switched on by default in the chart Indicators menu (Settings › Indicators). Per-browser, localStorage. */
const KEY = "fildi_default_indicators";
const EVT = "fildi:default-indicators";

/** `fallback` = the chart's own default when Settings › Indicators was never touched (key absent). */
export function getDefaultIndicators(fallback: string[] = []): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch { return fallback; }
}

export function setDefaultIndicator(id: string, on: boolean): string[] {
  const set = new Set(getDefaultIndicators());
  if (on) set.add(id); else set.delete(id);
  const next = [...set];
  try { localStorage.setItem(KEY, JSON.stringify(next)); window.dispatchEvent(new Event(EVT)); } catch { /* storage blocked */ }
  return next;
}
