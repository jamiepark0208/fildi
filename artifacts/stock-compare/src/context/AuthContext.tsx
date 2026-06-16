import { createContext, useContext } from "react";
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

async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) return null;
  return res.json();
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data: user = null, isLoading, refetch } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: fetchMe,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  return (
    <AuthContext.Provider value={{ user, isLoading, isAdmin: user?.role === "admin", refetch }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
