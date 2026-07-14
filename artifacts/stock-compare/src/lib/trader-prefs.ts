export interface TraderPrefs {
  minWeeklyIncome: number;
}

export const DEFAULT_TRADER_PREFS: TraderPrefs = {
  minWeeklyIncome: 0.5,
};

function prefsKey(userId?: number): string {
  return userId ? `fildi_trader_prefs_${userId}` : "fildi_trader_prefs";
}

export function getTraderPrefs(userId?: number): TraderPrefs {
  try {
    const raw = localStorage.getItem(prefsKey(userId));
    if (!raw) return DEFAULT_TRADER_PREFS;
    return { ...DEFAULT_TRADER_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_TRADER_PREFS;
  }
}

export function saveTraderPrefs(prefs: TraderPrefs, userId?: number): void {
  try {
    localStorage.setItem(prefsKey(userId), JSON.stringify(prefs));
  } catch {}
}
