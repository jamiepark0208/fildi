// Shared macro types with no runtime imports. Extracted from macro-data.ts to
// break the macro-data ⇄ macro-static import cycle (macro-static's static
// tables need these types; macro-data needs macro-static's tables).
// macro-data.ts re-exports these, so existing `from "./macro-data.js"` type
// imports elsewhere keep working.

export interface FedMember {
  name: string;
  title: string;
  voting: boolean;
  stance: "hawkish" | "neutral" | "dovish";
  notes: string;
  recentChange?: string;
  photoUrl?: string;
  priority?: number;
}

export interface MacroEvent {
  date: string;
  event: string;
  importance: "high" | "medium" | "low";
}

export interface BankResearch {
  name: string;
  shortName: string;
  stance: "bullish" | "neutral" | "bearish";
  rateView: string;
  summary: string;
  lastUpdated: string;
}

export interface FedProjection {
  year: number;
  fedRate: number | null;
  gdp: number | null;
  unemployment: number | null;
  corePce: number | null;
}
