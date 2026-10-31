"use client";

import { useSyncExternalStore } from "react";

import { formatAge } from "@/lib/sentinel";

const TICK_MS = 5_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let current = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      listeners.forEach((item) => item());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** One shared clock, so a page of ages costs one timer and repaints only the ages. The server renders nothing here. */
export function useNow(): number | null {
  const now = useSyncExternalStore(subscribe, () => current || Date.now(), () => 0);
  return now || null;
}

export function Age({ at, fallback = "—", className }: { at: string | number | null | undefined; fallback?: string; className?: string }) {
  const now = useNow();
  if (at == null) return <span className={className}>{fallback}</span>;
  const iso = new Date(at).toISOString();
  return <time dateTime={iso} className={className} suppressHydrationWarning>{now == null ? "" : formatAge(now - new Date(at).getTime())}</time>;
}
