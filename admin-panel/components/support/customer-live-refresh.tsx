"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps the customer's server-rendered ticket list current by re-running its
 * server render. Runs only while the tab is visible, never overlaps itself, and
 * re-syncs immediately when the tab returns or the network comes back.
 */
export function CustomerLiveRefresh({ intervalMs = 20_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible" && navigator.onLine) router.refresh(); };
    const id = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
    };
  }, [router, intervalMs]);
  return null;
}
