import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, setCsrf } from "../api/client";
import type { User } from "../api/types";

interface WorkspaceState {
  user: User | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<WorkspaceState | null>(null);

type SessionOut = { user: User; csrf_token: string };

/**
 * No sign-in: each browser gets its own private workspace, held by an httpOnly
 * session cookie. Reuses the existing session when there is one.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const inflight = useRef<Promise<void> | null>(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      // returns this browser's workspace, creating it on the first visit
      const r = await api<SessionOut>("/api/auth/workspace", { method: "POST" });
      setCsrf(r.csrf_token);
      setUser(r.user);
    } catch (e) {
      setUser(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // several requests can hit a 401 at once: open the workspace only once
  const refresh = useCallback(() => {
    if (!inflight.current) inflight.current = start().finally(() => (inflight.current = null));
    return inflight.current;
  }, [start]);

  useEffect(() => {
    refresh();
    const onUnauth = () => refresh();
    window.addEventListener("pm:unauthorized", onUnauth);
    return () => window.removeEventListener("pm:unauthorized", onUnauth);
  }, [refresh]);

  return <Ctx.Provider value={{ user, loading, error, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth(): WorkspaceState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
