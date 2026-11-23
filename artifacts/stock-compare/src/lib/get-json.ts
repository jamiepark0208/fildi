/**
 * GET JSON that rejects on HTTP errors (11-23). `fetch(u).then(r => r.json())` handed a 429/500 body
 * ({ error } / { code, message }) to the page as data — with staleTime: Infinity it stuck for the session
 * and crashed Macro (`(events ?? []).filter is not a function`). React Query then retries instead.
 */
export async function getJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}`);
  return r.json() as Promise<T>;
}
