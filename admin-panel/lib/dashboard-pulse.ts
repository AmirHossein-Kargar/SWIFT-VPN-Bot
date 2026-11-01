export type Freshness = { state: "live" | "paused" | "stale" | "failed"; label: string };

function ageText(seconds: number): string {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

/**
 * What may be said about the figures on screen. "Live" needs the last answer to be recent and the last attempt to have worked:
 * two missed polls and it stops claiming to be live, whatever the numbers look like. Pure, so it is tested without a browser.
 */
export function pulseFreshness({ generatedAt, now, failed, hidden, pollMs }: { generatedAt: string; now: number; failed: boolean; hidden: boolean; pollMs: number }): Freshness {
  const seconds = Math.max(0, Math.round((now - Date.parse(generatedAt)) / 1000));
  if (hidden) return { state: "paused", label: "Paused while hidden" };
  if (failed) return { state: "failed", label: `Not updating. These figures are from ${ageText(seconds)}` };
  if (seconds * 1000 > pollMs * 2.5) return { state: "stale", label: `Last updated ${ageText(seconds)}` };
  return { state: "live", label: `Live, updated ${ageText(seconds)}` };
}
