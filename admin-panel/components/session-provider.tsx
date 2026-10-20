"use client";

import { createContext, useContext, type ReactNode } from "react";

interface SessionContextValue {
  actorTelegramId: string;
  csrfToken: string;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ value, children }: { value: SessionContextValue; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useAdminSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useAdminSession must be used within SessionProvider");
  return context;
}
