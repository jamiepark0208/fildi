import { logger } from "./logger";
import { jitter, sleep } from "./http-client";

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 500, onRetry } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        if (onRetry) {
          onRetry(attempt, err);
        } else {
          logger.warn({ err, attempt }, "withRetry: attempt failed, retrying");
        }
        // Shared jitter/sleep with fetchJsonWithRetry (A83 Wave 1).
        const backoff = baseDelayMs * 2 ** (attempt - 1);
        await sleep(jitter(backoff));
      }
    }
  }
  throw lastErr;
}
