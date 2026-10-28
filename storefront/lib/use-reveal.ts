import { useEffect } from "react";

/**
 * Scroll-reveal for every `[data-reveal]` block. Progressive enhancement: the
 * server-rendered page shows everything, and only blocks that start below the
 * fold are hidden here (after hydration) and shown again when they scroll into
 * view, so no content depends on this code and nothing shifts (opacity and
 * transform only). Skipped entirely for reduced-motion visitors; pricing is
 * never given `data-reveal`.
 */
export function useReveal() {
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const targets = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.remove("reveal-hidden");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    for (const element of targets) {
      // Already on screen (or the visitor jumped to an anchor below): leave it visible.
      if (element.getBoundingClientRect().top < window.innerHeight * 0.92) continue;
      element.classList.add("reveal-hidden");
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
      for (const element of targets) element.classList.remove("reveal-hidden");
    };
  }, []);
}
