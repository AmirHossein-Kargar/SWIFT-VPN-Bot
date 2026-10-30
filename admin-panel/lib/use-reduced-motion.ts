"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** For animation that CSS cannot reach, such as Recharts, which draws its transitions from JavaScript. */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => true);
}
