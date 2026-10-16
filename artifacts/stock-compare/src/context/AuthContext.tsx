import { createContext, useContext, useEffect, useRef } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

export interface AuthUser {
  id: number;
  email: string;
  username: string;
  role: "admin" | "member";
  avatarUrl: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isAdmin: boolean;
  refetch: UseQueryResult<AuthUser | null>["refetch"];
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  isAdmin: false,
  refetch: async () => ({ data: null, error: null, isError: false, isSuccess: false, status: "error" }) as any,
});

const AUTH_CACHE_KEY = "fildi_auth_user_v1";
/** Set by AccountDetailsPanel before calling /auth/logout — the only path that may clear the cache. */
export const AUTH_EXPLICIT_LOGOUT_KEY = "fildi_explicit_logout";
export const AUTH_RETURN_TO_KEY = "fildi_return_to";

export function readCachedUser(): AuthUser | null {
  try {
    const raw = sessionStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as AuthUser;
    return u?.id && u?.email ? u : null;
  } catch {
    return null;
  }
}

function writeCachedUser(user: AuthUser | null) {
  try {
    if (!user) sessionStorage.removeItem(AUTH_CACHE_KEY);
    else sessionStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(user));
  } catch { /* private mode */ }
}

function consumeExplicitLogout(): boolean {
  try {
    if (sessionStorage.getItem(AUTH_EXPLICIT_LOGOUT_KEY) === "1") {
      sessionStorage.removeItem(AUTH_EXPLICIT_LOGOUT_KEY);
      return true;
    }
  } catch { /* */ }
  return false;
}

async function fetchMeOnce(): Promise<{ kind: "user"; user: AuthUser } | { kind: "unauthorized" } | { kind: "transient"; error: Error }> {
  let res: Response;
  try {
    res = await fetch("/api/auth/me", { credentials: "include" });
  } catch {
    // Vite HMR / API --watch restart — keep prior user.
    return { kind: "transient", error: new Error("auth unreachable") };
  }
  if (res.status === 401) return { kind: "unauthorized" };
  if (!res.ok) return { kind: "transient", error: new Error(`auth me ${res.status}`) };
  return { kind: "user", user: await res.json() };
}

/**
 * Resolve session. Dev reality: UI HMR + API watch restarts race cookies and
 * briefly 401. If we still have a cached user and the user did NOT click Logout,
 * treat 401 as transient so the app never dumps them on /login mid-edit.
 */
async function fetchMe(): Promise<AuthUser | null> {
  const cached = readCachedUser();
  const explicit = consumeExplicitLogout();

  const first = await fetchMeOnce();
  if (first.kind === "user") return first.user;
  if (first.kind === "transient") throw first.error;

  await new Promise((r) => setTimeout(r, 600));
  const second = await fetchMeOnce();
  if (second.kind === "user") return second.user;
  if (second.kind === "transient") throw second.error;

  // Confirmed 401.
  if (explicit || !cached) {
    writeCachedUser(null);
    return null;
  }
  // Keep session sticky across HMR / API restarts.
  throw new Error("auth soft-401");
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const cached = typeof window !== "undefined" ? readCachedUser() : null;
  const hadCache = useRef(!!cached);

  const { data: user = cached, isLoading, refetch, isFetching, isError, dataUpdatedAt, status, failureCount } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: fetchMe,
    staleTime: 30 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 4,
    retryDelay: (n) => Math.min(800 * 2 ** n, 5000),
    // Focus refetch during HMR is what kicks people to login — disable.
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    placeholderData: (prev) => prev ?? cached ?? undefined,
    initialData: cached ?? undefined,
    initialDataUpdatedAt: cached ? Date.now() - 60_000 : undefined,
  });

  useEffect(() => {
    if (status === "success" && user) {
      writeCachedUser(user);
      hadCache.current = true;
    }
  }, [status, user]);

  // Sticky: cached / previous user wins over null while soft-401 retries run.
  const sticky = readCachedUser();
  const effectiveUser = user ?? sticky ?? (hadCache.current ? cached : null) ?? null;

  const effectivelyLoading =
    (isLoading && !effectiveUser && !dataUpdatedAt && !isError && !cached) ||
    (isFetching && !effectiveUser && !cached && failureCount > 0);

  return (
    <AuthContext.Provider
      value={{
        user: effectiveUser,
        isLoading: effectivelyLoading,
        isAdmin: effectiveUser?.role === "admin",
        refetch,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
