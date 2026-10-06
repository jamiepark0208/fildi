/**
 * Shares one in-progress run of `fn` among concurrent callers (same idea as
 * TTLCache.getOrCompute's in-flight map, without caching the result). Use for
 * expensive one-off actions — e.g. admin "Generate" buttons that call Haiku — so a
 * double-click or two open tabs pay for one run, not two. Arguments come from the
 * caller that starts the run; callers that join an in-flight run share its result.
 */
export function singleFlight<T, A extends unknown[] = []>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let pending: Promise<T> | null = null;
  return (...args: A) => {
    if (!pending) {
      pending = fn(...args).finally(() => { pending = null; });
    }
    return pending;
  };
}
