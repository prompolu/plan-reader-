import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { User } from "../api/types";
import { recoverJobs } from "../local/processing";

interface WorkspaceState {
  user: User | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<WorkspaceState | null>(null);

type SessionOut = { user: User };

/**
 * No sign-in and no server: all projects live on this device. The "user" is
 * the local profile (the name shown in the audit trail and on reports).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const inflight = useRef<Promise<void> | null>(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      const r = await api<SessionOut>("/api/auth/workspace", { method: "POST" });
      setUser(r.user);
    } catch (e) {
      setUser(null);
      const msg = (e as Error).message;
      setError(/indexeddb|database|storage/i.test(msg) ? "This browser does not allow the app to store data on this device (private browsing?). Open it in a normal window." : msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    if (!inflight.current) inflight.current = start().finally(() => (inflight.current = null));
    return inflight.current;
  }, [start]);

  useEffect(() => {
    refresh();
    // processing that was interrupted when the app was closed; queued jobs resume
    recoverJobs().catch((e) => console.error(e));
  }, [refresh]);

  return <Ctx.Provider value={{ user, loading, error, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth(): WorkspaceState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
