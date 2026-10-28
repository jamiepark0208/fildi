/**
 * Section-native confidence for Model List folders that lack a put-style option score.
 * Display only — never gates publish / allocate.
 */

export type SectionConfidenceKind = "setup" | "trim" | "urgency";

export type SectionConfidence = {
  score: number;
  rank: number;
  basis: string;
  kind: SectionConfidenceKind;
};

type Pillars = {
  own?: number | null;
  street?: number | null;
  premium?: number | null;
} | null;

type Contract = {
  win?: { rate?: number | null } | null;
} | null;

export type ConfidenceItem = {
  ticker: string;
  status?: string | null;
  score?: number | null;
  flags?: string[] | null;
  why?: string[] | null;
  pillars?: Pillars;
  contract?: Contract;
};

const STATUS_SETUP: Record<string, number> = {
  ok: 100,
  provisional: 60,
  warn: 35,
  unfunded: 40,
  review: 20,
};

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Covered-call setup quality — not call option_score (S061/S076). */
export function setupConfidence(item: ConfidenceItem): Omit<SectionConfidence, "rank"> {
  const status = String(item.status ?? "").toLowerCase();
  const statusScore = STATUS_SETUP[status] ?? 20;
  const parts: { w: number; v: number; label: string }[] = [
    { w: 0.4, v: statusScore, label: `status ${status || "?"}→${statusScore}` },
  ];

  const winRate = item.contract?.win?.rate;
  if (winRate != null && Number.isFinite(winRate)) {
    const v = clamp(winRate * 100);
    parts.push({ w: 0.35, v, label: `hist win ${v}%` });
  }

  const pillarVals = [item.pillars?.own, item.pillars?.street, item.pillars?.premium]
    .filter((x): x is number => x != null && Number.isFinite(x));
  const pMean = mean(pillarVals);
  if (pMean != null) {
    parts.push({ w: 0.25, v: clamp(pMean), label: `pillars ${clamp(pMean)}` });
  }

  const wSum = parts.reduce((a, p) => a + p.w, 0);
  const score = clamp(parts.reduce((a, p) => a + p.v * (p.w / wSum), 0));
  return {
    score,
    kind: "setup",
    basis: `Setup confidence ${score}: ${parts.map((p) => p.label).join(" · ")} (not call option score)`,
  };
}

/** Trim severity from counted flags + known distress bumps. Falling-knife context ignored (S058). */
export function trimConfidence(item: ConfidenceItem): Omit<SectionConfidence, "rank"> {
  const lines = [...(item.flags ?? []), ...(item.why ?? [])].map(String);
  const counted = lines.filter((l) => !/falling-knife|context only/i.test(l));
  // Gate is ≥2 flags; score field from plan is len(flags) including context — prefer counted.
  const n = Math.max(counted.length, typeof item.score === "number" ? Math.floor(item.score) : 0);
  let score = n >= 2 ? 50 + 15 * (n - 2) : n === 1 ? 30 : 10;
  const bumps: string[] = [];
  const blob = counted.join(" | ");
  if (/credit\s+\d{1,2}\/100|high distress/i.test(blob)) {
    score += 10;
    bumps.push("credit distress +10");
  }
  if (/ARM\s+\d{1,2}\/100|analysts cutting/i.test(blob)) {
    score += 5;
    bumps.push("ARM +5");
  }
  if (/predicts a .*miss|pred.?surprise/i.test(blob)) {
    score += 10;
    bumps.push("miss risk +10");
  }
  score = clamp(score, 0, 95);
  return {
    score,
    kind: "trim",
    basis: `Trim confidence ${score}: ${n} flag(s)${bumps.length ? ` · ${bumps.join(", ")}` : ""}`,
  };
}

/** Manage urgency — action priority, not trade quality. */
export function urgencyConfidence(item: ConfidenceItem): Omit<SectionConfidence, "rank"> {
  const lines = (item.why ?? []).map(String);
  let score = 20;
  let label = "open short";
  for (const a of lines) {
    if (/^in the money/i.test(a)) {
      score = Math.max(score, 95);
      label = "in the money";
    } else if (/^at risk/i.test(a)) {
      score = Math.max(score, 75);
      if (label === "open short") label = "at risk";
    } else if (/^close to fund/i.test(a)) {
      score = Math.max(score, 55);
      if (label === "open short") label = "close to fund";
    } else if (/^take profit/i.test(a)) {
      score = Math.max(score, 45);
      if (label === "open short") label = "take profit";
    } else {
      const m = a.match(/^expires in (\d+)d/i);
      if (m) {
        const days = Number(m[1]);
        const urg = clamp(30 + Math.max(0, 14 - days) * 3, 30, 70);
        if (urg >= score) {
          score = urg;
          label = `expires ${days}d`;
        }
      }
    }
  }
  return {
    score: clamp(score),
    kind: "urgency",
    basis: `Urgency ${score}: ${label}`,
  };
}

export function confidenceForFolder(
  folderKey: string,
  item: ConfidenceItem,
): Omit<SectionConfidence, "rank"> | null {
  if (folderKey === "sell_calls") return setupConfidence(item);
  if (folderKey === "trim_risk") return trimConfidence(item);
  if (folderKey === "manage") return urgencyConfidence(item);
  return null;
}

/** Attach confidence + within-folder rank (1 = highest score). Mutates items. */
export function attachSectionConfidence(
  folderKey: string,
  items: Array<ConfidenceItem & { confidence?: SectionConfidence }>,
): void {
  const scored = items.map((it) => {
    const base = confidenceForFolder(folderKey, it);
    return { it, base };
  });
  if (scored.every((s) => !s.base)) return;

  const order = [...scored].sort((a, b) => {
    const sa = a.base?.score ?? -1;
    const sb = b.base?.score ?? -1;
    if (sb !== sa) return sb - sa;
    return String(a.it.ticker).localeCompare(String(b.it.ticker));
  });
  const rankBy = new Map<ConfidenceItem, number>();
  order.forEach((s, i) => {
    if (s.base) rankBy.set(s.it, i + 1);
  });

  for (const { it, base } of scored) {
    if (!base) continue;
    it.confidence = { ...base, rank: rankBy.get(it) ?? items.length };
  }
}
