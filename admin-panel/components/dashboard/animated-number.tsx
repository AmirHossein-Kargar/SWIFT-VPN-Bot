"use client";

import { useEffect, useRef, useState } from "react";

import { useReducedMotion } from "@/lib/use-reduced-motion";

const DURATION_MS = 550;
const easeOut = (progress: number) => 1 - (1 - progress) ** 3;

/**
 * Counts from the last value the server gave to the new one. The target is always a real value; only the frames in between are
 * drawn. The first render shows the value directly, so opening the page counts nothing up from zero, and screen readers get the
 * final figure alone. `tabular-nums` keeps the card from changing width while the digits run.
 */
export function AnimatedNumber({ value, format }: { value: number; format: (value: number) => string }) {
  const reducedMotion = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    if (from.current === value) return;
    const start = from.current;
    from.current = value;
    if (reducedMotion || document.hidden) {
      setShown(value);
      return;
    }
    let frame = 0;
    const began = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - began) / DURATION_MS);
      setShown(progress === 1 ? value : Math.round(start + (value - start) * easeOut(progress)));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, reducedMotion]);

  return (
    <span className="tabular-nums">
      <span aria-hidden="true">{format(shown)}</span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}
