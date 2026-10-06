/**
 * Parse Haiku desk brief into section cards.
 * Accepts markdown list bullets AND bare catalyst lines (`**Lead** — detail`).
 */
export function parseSections(md: string): Array<{ title: string; bullets: string[] }> {
  const sections: Array<{ title: string; bullets: string[] }> = [];
  let cur: { title: string; bullets: string[] } | null = null;
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t || t === "---" || t === "***") continue;
    if (t.startsWith("## ")) {
      cur = { title: t.slice(3).trim(), bullets: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    if (t.startsWith("- ") || t.startsWith("* ")) {
      cur.bullets.push(t.slice(2).trim());
      continue;
    }
    if (/^\d+[\).]\s+/.test(t)) {
      cur.bullets.push(t.replace(/^\d+[\).]\s+/, "").trim());
      continue;
    }
    if (t.length >= 12 && !t.startsWith("#")) {
      cur.bullets.push(t);
    }
  }
  return sections.filter((s) => s.bullets.length > 0);
}
