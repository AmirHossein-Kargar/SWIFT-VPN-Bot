"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A horizontal scroller for content that cannot reflow: a wide table, a ledger, a block of JSON. It stays out of the tab
 * order until there is something to scroll, then becomes a named region so a keyboard can reach it, and it fades the edge
 * that has more behind it, because a phone hides its scrollbars.
 */
export function ScrollRegion({ label, className, children, ...props }: React.HTMLAttributes<HTMLDivElement> & { label: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = React.useState(false);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const overflow = element.scrollWidth - element.clientWidth;
      setScrollable(overflow > 1);
      const start = Math.abs(element.scrollLeft);
      element.dataset.edge = overflow <= 1 ? "none" : start <= 1 ? "end" : start >= overflow - 1 ? "start" : "both";
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className={cn("scroll-region relative w-full overflow-x-auto", className)}
      {...(scrollable ? { tabIndex: 0, role: "region", "aria-label": label } : {})}
      {...props}
    >
      {children}
    </div>
  );
}
