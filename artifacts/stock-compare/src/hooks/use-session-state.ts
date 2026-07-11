import { useState, useCallback, type Dispatch, type SetStateAction } from "react";

// Tab-lifetime state backed by sessionStorage — survives route changes within
// the same tab, cleared on close. Use for "what was I looking at" UI state
// (active sub-tab, expanded rows), not for data that should persist forever.
export function useSessionState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [val, set] = useState<T>(() => {
    try {
      const v = sessionStorage.getItem(key);
      return v ? JSON.parse(v) : initial;
    } catch { return initial; }
  });
  const setVal = useCallback<Dispatch<SetStateAction<T>>>(action => {
    set(prev => {
      const next = typeof action === "function" ? (action as (p: T) => T)(prev) : action;
      try { sessionStorage.setItem(key, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [key]);
  return [val, setVal];
}
