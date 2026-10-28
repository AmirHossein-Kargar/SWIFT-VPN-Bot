/**
 * How a service health status is presented. The status itself always comes from
 * GET /api/admin/system/health (services/admin/systemHealth.js); nothing here
 * derives, defaults or simulates health. Anything the API does not report as
 * exactly "healthy", "degraded" or "down" is shown as unknown, never as healthy.
 */
export type HealthStatus = "healthy" | "degraded" | "down" | "unknown";

/** `beat`: calm sweep, `irregular`: slower, flatter sweep, `flatline`: no signal, `idle`: nothing verified yet. */
export type EcgMotion = "beat" | "irregular" | "flatline" | "idle";

export interface HealthPresentation {
  status: HealthStatus;
  label: string;
  motion: EcgMotion;
  /** Tailwind text colour; the trace uses currentColor. */
  tone: string;
  /** Plain-language status for assistive technology (the animation itself is aria-hidden). */
  description: string;
}

const PRESENTATION: Record<HealthStatus, Omit<HealthPresentation, "status">> = {
  healthy: { label: "Healthy", motion: "beat", tone: "text-success", description: "Healthy: the last check succeeded" },
  degraded: { label: "Degraded", motion: "irregular", tone: "text-warning", description: "Degraded: the last check succeeded with problems" },
  down: { label: "Down", motion: "flatline", tone: "text-destructive", description: "Down: the last check failed" },
  unknown: { label: "Unknown", motion: "idle", tone: "text-muted-foreground", description: "Unknown: no verified result yet" },
};

export function normalizeHealthStatus(value: unknown): HealthStatus {
  return value === "healthy" || value === "degraded" || value === "down" ? value : "unknown";
}

export function presentHealth(value: unknown): HealthPresentation {
  const status = normalizeHealthStatus(value);
  return { status, ...PRESENTATION[status] };
}

/** One P-QRS-T beat followed by a flat baseline, in a 120x28 box (shared by every animated state). */
export const ECG_BEAT_PATH = "M0 14 H26 L30 11 L34 14 H44 L48 17 L53 2 L58 26 L62 14 H74 L80 9 L86 14 H120";
/** No signal: a straight baseline. */
export const ECG_FLAT_PATH = "M0 14 H120";
