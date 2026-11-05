/** Indicators switched on by default in the chart Indicators menu (Settings › Indicators). Per-browser, localStorage. */
const KEY = "fildi_default_indicators";
const EVT = "fildi:default-indicators";

export function getDefaultIndicators(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

export function setDefaultIndicator(id: string, on: boolean): string[] {
  const set = new Set(getDefaultIndicators());
  if (on) set.add(id); else set.delete(id);
  const next = [...set];
  try { localStorage.setItem(KEY, JSON.stringify(next)); window.dispatchEvent(new Event(EVT)); } catch { /* storage blocked */ }
  return next;
}
