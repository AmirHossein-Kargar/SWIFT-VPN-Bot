"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Connection = "live" | "reconnecting" | "paused";

export interface PollResult {
  /** More data is waiting: poll again right away instead of after the interval. */
  again?: boolean;
  /** Stop polling for good (session expired, ticket gone). */
  stop?: boolean;
}

/**
 * Authenticated polling that stays out of the way:
 *  - runs only while the tab is visible and never overlaps itself;
 *  - catches up immediately when the tab returns or the network comes back;
 *  - backs off (up to 30s) after failures and reports `reconnecting`;
 *  - `trigger()` asks for a poll as soon as possible, even if one is in flight.
 *
 * Every poll is an ordinary request carrying the admin session cookie, so a
 * session that expires or is revoked simply starts failing with 401 and the
 * task ends the loop (`stop`). Nothing outlives the component: the effect
 * clears its timer and listeners on unmount.
 */
export function useVisiblePolling(task: () => Promise<PollResult | void>, { intervalMs, resetKey }: { intervalMs: number; resetKey?: unknown }) {
  const [connection, setConnection] = useState<Connection>("live");
  const taskRef = useRef(task);
  const triggerRef = useRef<() => void>(() => {});

  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let rerun = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    };

    const run = async (): Promise<void> => {
      if (stopped) return;
      if (inFlight) { rerun = true; return; }
      if (document.visibilityState === "hidden") { setConnection("paused"); return; } // resumed by visibilitychange
      inFlight = true;
      try {
        const result = (await taskRef.current()) || {};
        if (stopped) return;
        failures = 0;
        setConnection("live");
        if (result.stop) { stopped = true; return; }
        schedule(result.again ? 150 : intervalMs);
      } catch {
        if (stopped) return;
        failures += 1;
        setConnection("reconnecting");
        schedule(Math.min(30_000, intervalMs * 2 ** Math.min(failures, 4)));
      } finally {
        inFlight = false;
        if (rerun && !stopped) { rerun = false; void run(); }
      }
    };

    const wake = () => {
      if (document.visibilityState !== "visible") return;
      failures = 0;
      void run();
    };
    triggerRef.current = () => {
      failures = 0;
      if (timer) clearTimeout(timer);
      void run();
    };

    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    void run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      triggerRef.current = () => {};
    };
  }, [intervalMs, resetKey]);

  const trigger = useCallback(() => triggerRef.current(), []);
  return { connection, trigger };
}

export function ConnectionStatus({ connection }: { connection: Connection }) {
  const label = connection === "live" ? "Live" : connection === "reconnecting" ? "Reconnecting…" : "Paused (tab hidden)";
  const dot = connection === "live" ? "bg-success" : connection === "reconnecting" ? "bg-warning" : "bg-muted-foreground";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
      <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
