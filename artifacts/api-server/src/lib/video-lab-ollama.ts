/**
 * A125 — local Ollama hook brainstorm for Video Lab (free, optional).
 * If Ollama is down, returns a deterministic template so the UI still works.
 */
import { logger } from "./logger.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_VIDEO_MODEL ?? "llama3.2";

export type HookIdea = { topic: string; hook: string; outline: string[] };

function templateHooks(topic: string): HookIdea[] {
  const t = topic.trim() || "markets";
  return [
    {
      topic: t,
      hook: `Everyone's wrong about ${t} — here's the 15-second take.`,
      outline: ["cold open claim", "one chart / number", "what I'd watch next", "CTA"],
    },
    {
      topic: t,
      hook: `If you only understand one thing about ${t} this week…`,
      outline: ["misconception", "simple frame", "trade-off", "CTA"],
    },
    {
      topic: t,
      hook: `${t}: the part CNBC skips.`,
      outline: ["setup", "hidden driver", "so what", "CTA"],
    },
  ];
}

function parseIdeas(text: string, topic: string): HookIdea[] {
  const ideas: HookIdea[] = [];
  // Expect lines like: HOOK: ... | OUTLINE: a; b; c
  for (const line of text.split("\n")) {
    const m = /HOOK:\s*(.+?)(?:\s*\|\s*OUTLINE:\s*(.+))?$/i.exec(line.trim());
    if (!m) continue;
    const hook = m[1]!.trim();
    const outline = (m[2] ?? "hook; demo; CTA")
      .split(/[;|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (hook.length >= 8) ideas.push({ topic, hook, outline });
  }
  return ideas.slice(0, 5);
}

export async function generateVideoHooks(topic: string): Promise<{
  ideas: HookIdea[];
  source: "ollama" | "template";
  model?: string;
  error?: string;
}> {
  const t = topic.trim().slice(0, 120);
  if (t.length < 2) return { ideas: [], source: "template", error: "topic required" };

  const prompt =
    `You write short-form finance video hooks. Topic: "${t}".\n` +
    `Return exactly 3 lines, each format:\n` +
    `HOOK: <one punchy sentence> | OUTLINE: step1; step2; step3; CTA\n` +
    `No numbering, no markdown.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, stream: false }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const err = `ollama HTTP ${res.status}`;
      logger.info({ err }, "video-lab-ollama: fallback template");
      return { ideas: templateHooks(t), source: "template", error: err };
    }
    const body = (await res.json()) as { response?: string };
    const parsed = parseIdeas(body.response ?? "", t);
    if (parsed.length === 0) {
      return { ideas: templateHooks(t), source: "template", error: "unparseable ollama response", model: MODEL };
    }
    return { ideas: parsed, source: "ollama", model: MODEL };
  } catch (err) {
    clearTimeout(timer);
    const msg = String(err instanceof Error ? err.message : err);
    logger.info({ err: msg }, "video-lab-ollama: fallback template");
    return { ideas: templateHooks(t), source: "template", error: msg };
  }
}
