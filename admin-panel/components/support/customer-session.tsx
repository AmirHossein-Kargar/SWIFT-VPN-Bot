"use client";

import { createContext, useContext, type ReactNode } from "react";

const CustomerSessionContext = createContext<{ csrfToken: string } | null>(null);

export function CustomerSessionProvider({ csrfToken, children }: { csrfToken: string; children: ReactNode }) {
  return <CustomerSessionContext.Provider value={{ csrfToken }}>{children}</CustomerSessionContext.Provider>;
}

export function useCustomerSession() {
  const context = useContext(CustomerSessionContext);
  if (!context) throw new Error("useCustomerSession must be used within CustomerSessionProvider");
  return context;
}
