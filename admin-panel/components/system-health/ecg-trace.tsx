import { cn } from "@/lib/utils";
import { ECG_BEAT_PATH, ECG_FLAT_PATH, type EcgMotion } from "@/lib/health-status";

/**
 * Decorative ECG trace for a service's reported health. The state is always
 * also written out as text next to it, so this is aria-hidden and carries no
 * information of its own. A faint full waveform is always drawn; for the
 * animated states a short bright segment sweeps along it (CSS, see
 * `.ecg-sweep` in globals.css) only when the user has not asked for reduced
 * motion. The box has a fixed size so the animation never shifts layout.
 */
export function EcgTrace({ motion, className }: { motion: EcgMotion; className?: string }) {
  const animated = motion === "beat" || motion === "irregular";
  const path = animated ? ECG_BEAT_PATH : ECG_FLAT_PATH;
  return (
    <svg
      viewBox="0 0 120 28"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      data-ecg={motion}
      className={cn("h-7 w-full max-w-40 shrink-0 overflow-hidden", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} pathLength={100} vectorEffect="non-scaling-stroke" opacity={animated ? 0.28 : motion === "idle" ? 0.5 : 0.9} strokeDasharray={motion === "idle" ? "3 5" : undefined} />
      {animated ? <path d={path} pathLength={100} vectorEffect="non-scaling-stroke" className={cn("ecg-sweep", motion === "irregular" && "ecg-sweep-slow")} /> : null}
    </svg>
  );
}
