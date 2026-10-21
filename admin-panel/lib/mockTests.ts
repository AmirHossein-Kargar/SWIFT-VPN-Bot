// Pure helpers for the Mock Tests page. No imports, so they can be unit-tested
// directly with Node's built-in type stripping (tests/unit/mockTestsUi.test.js).

export type ScenarioStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT RUN";
export type OverallStatus = ScenarioStatus | "PARTIAL";

export interface ListingLike {
  enabled: boolean;
  running: boolean;
  source: string;
  scenarios: { id: string; title: string; titleFa: string }[];
  items: RunLike[];
}

export interface RunLike {
  runId: string;
  trigger: string;
  requestedScenarios: string[];
  startedAt: string;
  completedAt: string;
  summary: { overall: OverallStatus; PASS: number; FAIL: number; BLOCKED: number; "NOT RUN": number; assertions: number; assertionsFailed: number };
  scenarios: { id: string; title: string; titleFa: string; status: ScenarioStatus; counts: { total: number; passed: number; failed: number; skipped: number }; explanation: string | null }[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const STATUSES: ScenarioStatus[] = ["PASS", "FAIL", "BLOCKED", "NOT RUN"];
const OVERALL: OverallStatus[] = [...STATUSES, "PARTIAL"];

function normalizeRun(raw: unknown): RunLike | null {
  if (!isObject(raw) || typeof raw.runId !== "string") return null;
  const summary = isObject(raw.summary) ? raw.summary : {};
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const overall = OVERALL.includes(summary.overall as OverallStatus) ? (summary.overall as OverallStatus) : "NOT RUN";
  const scenarios = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  return {
    runId: raw.runId,
    trigger: typeof raw.trigger === "string" ? raw.trigger : "unknown",
    requestedScenarios: Array.isArray(raw.requestedScenarios) ? raw.requestedScenarios.filter((id): id is string => typeof id === "string") : [],
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : "",
    summary: {
      overall,
      PASS: num(summary.PASS),
      FAIL: num(summary.FAIL),
      BLOCKED: num(summary.BLOCKED),
      "NOT RUN": num(summary["NOT RUN"]),
      assertions: num(summary.assertions),
      assertionsFailed: num(summary.assertionsFailed),
    },
    scenarios: scenarios.filter(isObject).map((scenario) => {
      const counts = isObject(scenario.counts) ? scenario.counts : {};
      return {
        id: String(scenario.id ?? ""),
        title: String(scenario.title ?? scenario.id ?? "Scenario"),
        titleFa: String(scenario.titleFa ?? ""),
        // An unknown status is never upgraded to a pass.
        status: STATUSES.includes(scenario.status as ScenarioStatus) ? (scenario.status as ScenarioStatus) : "NOT RUN",
        counts: { total: num(counts.total), passed: num(counts.passed), failed: num(counts.failed), skipped: num(counts.skipped) },
        explanation: typeof scenario.explanation === "string" ? scenario.explanation : null,
      };
    }),
  };
}

/**
 * GET /api/admin/mock-tests returns { enabled, running, source, scenarios, items }.
 * The original page typed it as an array and crashed on `runs.map`; this also
 * tolerates a malformed or legacy response instead of throwing during render.
 */
export function normalizeListing(raw: unknown): ListingLike {
  if (Array.isArray(raw)) {
    return { enabled: false, running: false, source: "unknown", scenarios: [], items: raw.map(normalizeRun).filter((run): run is RunLike => run !== null) };
  }
  const listing = isObject(raw) ? raw : {};
  return {
    enabled: listing.enabled === true,
    running: listing.running === true,
    source: typeof listing.source === "string" ? listing.source : "unknown",
    scenarios: Array.isArray(listing.scenarios)
      ? listing.scenarios.filter(isObject).filter((s) => typeof s.id === "string").map((s) => ({ id: String(s.id), title: String(s.title ?? s.id), titleFa: String(s.titleFa ?? "") }))
      : [],
    items: Array.isArray(listing.items) ? listing.items.map(normalizeRun).filter((run): run is RunLike => run !== null) : [],
  };
}

export function runDurationMs(run: Pick<RunLike, "startedAt" | "completedAt">): number | null {
  const start = Date.parse(run.startedAt);
  const end = Date.parse(run.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** Why a run cannot be started right now, or null when it can. */
export function runBlockedReason(listing: Pick<ListingLike, "enabled" | "running">, submitting: boolean): string | null {
  if (!listing.enabled) return "Mock testing is disabled on this server. Set MOCK_TESTS_ENABLED=true in the server environment to allow runs.";
  if (submitting) return "A run is in progress.";
  if (listing.running) return "A run started elsewhere (Telegram or another admin) is still in progress.";
  return null;
}

/** A run counts as passed only when every requested scenario actually executed and passed. */
export function isGenuinePass(run: Pick<RunLike, "summary">): boolean {
  return run.summary.overall === "PASS" && run.summary.FAIL === 0 && run.summary.BLOCKED === 0 && run.summary.PASS > 0;
}
