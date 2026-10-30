"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Briefly highlights its content when `value` changes. `value` must be server data (a refreshed status or balance),
 * never local intent: this is how a confirmed change becomes visible, so it must not be able to fire before the server
 * has answered. The first render never flashes, so a loading table stays still.
 */
export function ChangeFlash({ value, className, children }: { value: string | number | boolean; className?: string; children: React.ReactNode }) {
  const previous = useRef(value);
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setChanges((count) => count + 1);
  }, [value]);

  return <span key={changes} data-changed={changes > 0 ? "true" : undefined} className={cn("inline-block rounded-md", changes > 0 && "change-flash", className)}>{children}</span>;
}
