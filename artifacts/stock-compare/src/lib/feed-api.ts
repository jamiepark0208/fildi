/** Fetch helper for /api/feed routes (session cookie; throws the response text on non-2xx). */
export async function apiFeed(path: string, opts?: RequestInit) {
  const r = await fetch(`/api/feed${path}`, { credentials: "include", ...opts });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
