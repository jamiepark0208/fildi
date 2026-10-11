/**
 * Safeguards for Daily News Haiku output — reject empty / shallow-teaser / Muse-paraphrase copy.
 */

export interface QualityResult {
  ok: boolean;
  reasons: string[];
}

const SHALLOW_CITE_RE =
  /\b\d+\s+new analyst rating|\bdrew\s+\d+\s+new analyst|Monitor TipRanks\b|firm\/grade not confirmed/i;

const FILLER_RE =
  /\b(worth watching|stay tuned|more to come|as always|nothing material|no major news)\b/i;

const MUSE_PARAPHRASE_RE =
  /^#\s*Morning market brief|^#\s*Evening Market Recap|\*\*Banner:\*\*/im;

/** Strip bullets/lines that only restate TipRanks count teasers. */
export function sanitizeDailyNewsContent(content: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (MUSE_PARAPHRASE_RE.test(line)) continue;
    if (SHALLOW_CITE_RE.test(line) && !/\b(Wells|Morgan|Goldman|JP|UBS|Barclays|Deutsche|Piper|Cantor|Freedom|Rosenblatt)\b/i.test(line)) {
      continue;
    }
    kept.push(line);
  }
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i]!;
    if (/^##\s/.test(line)) {
      const next = kept.slice(i + 1).find((l) => l.trim().length > 0);
      if (!next || /^##\s/.test(next)) continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function assessDailyNewsQuality(content: string): QualityResult {
  const reasons: string[] = [];
  const trimmed = content.trim();
  if (trimmed.length < 40) reasons.push("content too short");

  if (SHALLOW_CITE_RE.test(trimmed)) {
    reasons.push("cites TipRanks count teaser without firm/grade");
  }
  if (MUSE_PARAPHRASE_RE.test(trimmed)) {
    reasons.push("paraphrases or pastes Muse brief title/banner");
  }

  // Accept new append-only structure OR legacy overnight (during transition)
  const hasDeskAdds = /##\s*Desk adds/i.test(trimmed);
  const hasLegacyMacro = /##\s*Overnight\s*\/\s*Macro/i.test(trimmed);
  if (!hasDeskAdds && !hasLegacyMacro) {
    reasons.push("missing Desk adds (or legacy Overnight / Macro) section");
  }
  if (!/##\s*Put-seller takeaway/i.test(trimmed)) {
    reasons.push("missing Put-seller takeaway section");
  }

  const bullets = trimmed.split("\n").filter((l) => {
    const t = l.trim();
    return (
      t.startsWith("- ") ||
      t.startsWith("* ") ||
      /^\*\*[^*]+\*\*/.test(t) ||
      (/^[A-Z0-9*$]/.test(t) && t.length >= 20 && !t.startsWith("##"))
    );
  });
  const noAddsOk = /No material desk adds/i.test(trimmed);
  const substantive = bullets.filter(
    (l) =>
      (/[%$]|bps|\d+\.\d+|PT\s*\$|upgrade|downgrade|maintain|reiterate|initiate|futures|yield|WTI|Brent|earnings|S&P|Nasdaq|VIX|sell put|sell call|no model contract|No material desk adds/i.test(
        l,
      ) && !SHALLOW_CITE_RE.test(l)),
  );
  if (!noAddsOk && substantive.length < 2) {
    reasons.push("fewer than 2 substantive append bullets");
  }

  if (hasDeskAdds && /##\s*Desk adds\s*\n+(?:##|$)/i.test(trimmed)) {
    reasons.push("Desk adds section is empty");
  }
  if (hasLegacyMacro && /##\s*Overnight\s*\/\s*Macro\s*\n+(?:##|$)/i.test(trimmed)) {
    reasons.push("Overnight / Macro section is empty");
  }

  if (FILLER_RE.test(trimmed) && substantive.length < 2 && !noAddsOk) {
    reasons.push("filler language without enough hard facts");
  }

  return { ok: reasons.length === 0, reasons };
}
