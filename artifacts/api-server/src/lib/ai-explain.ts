// Generalizes the cache-lookup -> Haiku-call -> upsert pattern so every "Explain AI"
// surface (score, options scanner, live regime, model pick, ...) shares one path
// instead of re-inlining it.
import { eq, and, desc } from "drizzle-orm";
import { db, explainCache } from "@workspace/db";
import type { Logger } from "pino";
import type { ContextBundle } from "./explain-context.js";
import { callHaiku } from "./haiku.js";
import { recordAiUsage } from "./ai-usage.js";

export interface ExplainSurface<TExtra> {
  surfaceType: string;
  promptVersion: string;
  buildPrompt: (bundle: ContextBundle, extra: TExtra) => string;
  // Must be prefixed with promptVersion by the caller so a prompt-copy change busts the cache.
  hashInputs: (bundle: ContextBundle, extra: TExtra) => string;
}

export interface ExplanationResult {
  explanation: string;
  cached: boolean;
  inputTokens: number;
  outputTokens: number;
}

// Concurrent misses for the same (ticker, surface, hash) share ONE Haiku call — two
// tabs / a double-click would otherwise each pay for an identical explanation.
const inflight = new Map<string, Promise<ExplanationResult>>();

export async function generateExplanation<TExtra>(
  ticker: string,
  surface: ExplainSurface<TExtra>,
  bundle: ContextBundle,
  extra: TExtra,
  log: Logger,
  opts?: { userId?: number; maxTokens?: number },
): Promise<ExplanationResult> {
  const scoreHash = surface.hashInputs(bundle, extra);
  const key = `${ticker}|${surface.surfaceType}|${scoreHash}`;

  const pending = inflight.get(key);
  if (pending) {
    log.info({ ticker, surfaceType: surface.surfaceType, step: "inflight-join" }, "ai-explain: joining in-flight generation");
    const shared = await pending;
    // The caller that started the call already logged its token usage; this one rode along for free.
    if (opts?.userId != null) recordAiUsage({ userId: opts.userId, ticker, surfaceType: surface.surfaceType, cached: true });
    return { ...shared, cached: true, inputTokens: 0, outputTokens: 0 };
  }

  const promise = lookupOrGenerate(ticker, surface, bundle, extra, scoreHash, log, opts);
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

async function lookupOrGenerate<TExtra>(
  ticker: string,
  surface: ExplainSurface<TExtra>,
  bundle: ContextBundle,
  extra: TExtra,
  scoreHash: string,
  log: Logger,
  opts?: { userId?: number; maxTokens?: number },
): Promise<ExplanationResult> {
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
    // callHaiku records misses; hits are recorded here so every surface's audit log is complete.
    if (opts?.userId != null) recordAiUsage({ userId: opts.userId, ticker, surfaceType: surface.surfaceType, cached: true });
    return { explanation: cached[0].explanation, cached: true, inputTokens: 0, outputTokens: 0 };
  }

  const prompt = surface.buildPrompt(bundle, extra);
  log.info({ ticker, surfaceType: surface.surfaceType, chars: prompt.length, step: "anthropic-call" }, "ai-explain: calling Haiku");

  let call;
  try {
    call = await callHaiku({
      prompt,
      maxTokens: opts?.maxTokens ?? 300,
      trigger: `explain/${surface.surfaceType}`,
      surfaceType: surface.surfaceType,
      userId: opts?.userId,
      ticker,
    });
  } catch (err) {
    // 11-23: Anthropic credit out → every Rankings 'Why' was a 500. Serve the last saved explanation (dated) instead.
    const prev = await db.select().from(explainCache)
      .where(and(eq(explainCache.ticker, ticker), eq(explainCache.scoreType, surface.surfaceType)))
      .orderBy(desc(explainCache.generatedAt)).limit(1).catch(() => []);
    if (prev.length > 0) {
      log.warn({ ticker, surfaceType: surface.surfaceType, err: String(err), step: "stale-fallback" }, "ai-explain: AI failed, serving last saved");
      const d = new Date(prev[0].generatedAt).toISOString().slice(0, 10);
      return { explanation: `${prev[0].explanation}\n\n(Saved ${d}; scores may have moved since. AI explain is offline.)`, cached: true, inputTokens: 0, outputTokens: 0 };
    }
    throw err;
  }
  const { text: explanation, inputTokens, outputTokens } = call;
  log.info({ ticker, surfaceType: surface.surfaceType, chars: explanation.length, inputTokens, outputTokens, step: "anthropic-ok" }, "ai-explain: got response");

  // One row per (ticker, surfaceType): a new hash replaces the old explanation. Surfaces
  // whose variants should coexist (e.g. technical put vs call lens) need distinct surfaceTypes.
  await db.insert(explainCache)
    .values({ ticker, scoreType: surface.surfaceType, scoreHash, explanation })
    .onConflictDoUpdate({
      target: [explainCache.ticker, explainCache.scoreType],
      set: { scoreHash, explanation, generatedAt: new Date() },
    });

  return { explanation, cached: false, inputTokens, outputTokens };
}
