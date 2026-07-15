// Generalizes the cache-lookup -> Haiku-call -> upsert pattern that routes/explain.ts
// originally inlined for fundamental/technical scores, so new "Explain AI" surfaces
// (options scanner, stock-breakdown, ...) can reuse it instead of duplicating it.
import Anthropic from "@anthropic-ai/sdk";
import { eq, and } from "drizzle-orm";
import { db, explainCache } from "@workspace/db";
import type { Logger } from "pino";
import type { ContextBundle } from "./explain-context.js";

const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });

export interface ExplainSurface<TExtra> {
  surfaceType: string;
  promptVersion: string;
  buildPrompt: (bundle: ContextBundle, extra: TExtra) => string;
  // Must be prefixed with promptVersion by the caller so a prompt-copy change busts the cache.
  hashInputs: (bundle: ContextBundle, extra: TExtra) => string;
}

export async function generateExplanation<TExtra>(
  ticker: string,
  surface: ExplainSurface<TExtra>,
  bundle: ContextBundle,
  extra: TExtra,
  log: Logger,
): Promise<{ explanation: string; cached: boolean }> {
  const scoreHash = surface.hashInputs(bundle, extra);

  log.info({ ticker, surfaceType: surface.surfaceType, scoreHash, step: "cache-lookup" }, "ai-explain: checking DB cache");

  const cached = await db.select()
    .from(explainCache)
    .where(and(
      eq(explainCache.ticker, ticker),
      eq(explainCache.scoreType, surface.surfaceType),
      eq(explainCache.scoreHash, scoreHash),
    ))
    .limit(1);

  if (cached.length > 0) {
    log.info({ ticker, surfaceType: surface.surfaceType, step: "cache-hit" }, "ai-explain: serving from cache");
    return { explanation: cached[0].explanation, cached: true };
  }

  const prompt = surface.buildPrompt(bundle, extra);
  log.info({ ticker, surfaceType: surface.surfaceType, chars: prompt.length, step: "anthropic-call" }, "ai-explain: calling Haiku");

  const msg = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages:   [{ role: "user", content: prompt }],
  });

  const explanation = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
  log.info({ ticker, surfaceType: surface.surfaceType, chars: explanation.length, step: "anthropic-ok" }, "ai-explain: got response");

  await db.insert(explainCache)
    .values({ ticker, scoreType: surface.surfaceType, scoreHash, explanation })
    .onConflictDoUpdate({
      target: [explainCache.ticker, explainCache.scoreType],
      set: { scoreHash, explanation, generatedAt: new Date() },
    });

  return { explanation, cached: false };
}
