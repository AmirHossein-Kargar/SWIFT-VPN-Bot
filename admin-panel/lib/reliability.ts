/**
 * The Service Reliability Center in the browser: API shapes, labels, and the pure logic of the live feed and the topology.
 * Nothing here decides a health state; every state comes from the server, and this only says how fresh it is.
 */

export type HealthState = "healthy" | "degraded" | "failed" | "stale" | "unknown";
export type RangeName = "15m" | "1h" | "6h" | "24h";
export type IncidentSeverity = "critical" | "high" | "medium" | "low";
export type EventSeverity = "critical" | "error" | "warning" | "info" | "debug";
export type ComponentId = "telegram" | "hooshpay" | "nowpayments" | "wizardxray" | "polling" | "express" | "webhook" | "orders" | "delivery" | "jobs" | "mongodb" | "redis";

export interface DetailRow { label: string; value: string }

export interface ComponentHealth {
  id: ComponentId;
  label: string;
  group: string;
  critical: boolean;
  role: string;
  dependsOn: ComponentId[];
  state: HealthState;
  reason: string;
  evidence: "probe" | "process" | "traffic" | "records" | "config" | "none";
  checkedAt: string | null;
  lastSuccessAt: string | null;
  latencyMs: number | null;
  details: DetailRow[];
  incidents: number;
}

export interface TopologyEdge {
  id: string;
  from: ComponentId;
  to: ComponentId;
  kind: "flow" | "uses";
  label: string;
  unit: string | null;
  tone: "normal" | "return";
  measured: boolean;
  count: number | null;
  perMinute: number | null;
}

export interface Percentile { valueMs: number | null; over: boolean }
export interface Percentiles { samples: number; p50: Percentile | null; p95: Percentile | null; p99: Percentile | null }

export interface OrderCohort {
  created: number;
  attempted: number;
  delivered: number;
  failed: number;
  inFlight: number;
  successRate: number | null;
  fulfilment: Percentiles;
  provider: Percentiles;
  truncated: boolean;
}

export interface WindowMetrics {
  window: RangeName;
  coverage: { observedMinutes: number; expectedMinutes: number; ratio: number; since: string | null; instanceStartedAt: string };
  throughput: { count: number; perMinute: number; http: number; webhooks: number; telegramUpdates: number; spark: number[] };
  errors: { count: number; attempts: number; rate: number | null; rejectedCallbacks: number; spark: number[] };
  timeouts: { count: number; attempts: number; rate: number | null };
  latency: { webhook: Percentiles; providerCreate: Percentiles; provider: Percentiles; http: Percentiles };
  orders: OrderCohort | null;
}

export interface IncidentBrief {
  id: string;
  code: string;
  component: ComponentId;
  severity: IncidentSeverity;
  state: "open" | "resolved";
  title: string;
  summary: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  resolvedAt: string | null;
  escalatedAt: string | null;
  detections: number;
  reopenCount: number;
  affectedOrders: number | null;
  path: ComponentId[];
}

export interface OrderRow { key: string; orderId: string; user: string | null; status: string; since: string; ageMs: number; limitMs: number; overdue: boolean; errorCode: string | null }

export interface ReliabilityEvent {
  id: string;
  at: string;
  lastAt: string | null;
  type: string;
  severity: EventSeverity;
  component: string;
  message: string;
  correlationId: string | null;
  orderKey: string | null;
  incidentId: string | null;
  count: number;
  source?: "records";
}

export interface JobState { name: string; label: string; everyMs: number; lastRunAt: string | null; lastOkAt: string | null; consecutiveFailures: number; runs: number; state: HealthState; reason: string }

export interface Snapshot {
  generatedAt: string;
  monitoring: {
    enabled: boolean;
    instance: string | null;
    startedAt: string | null;
    intervalSeconds: number;
    probeSeconds: number;
    lastTickAt: string | null;
    tickMs: number | null;
    persistence: { state: string; failures: number; lastSuccessAt: string | null; lastError: string | null };
    droppedEvents: number;
    fresh?: boolean;
    ageMs?: number | null;
  };
  overall: { state: HealthState; reason: string; affected: ComponentId[]; unverified: ComponentId[] };
  components: ComponentHealth[];
  edges: TopologyEdge[];
  metrics: Record<RangeName, WindowMetrics> | null;
  incidents: { open: IncidentBrief[]; openCount: number; bySeverity: Record<IncidentSeverity, number> };
  orders: { available: boolean; counts: Record<string, number | null> | null; unresolved: number | null; overdueCount: number | null; oldest: OrderRow | null; overdue: OrderRow[]; truncated: boolean };
  jobs: JobState[];
  eventLoop: { p50Ms: number | null; p99Ms: number | null; maxMs: number | null } | null;
  recentEvents: ReliabilityEvent[];
}

export interface EventPage { events: ReliabilityEvent[]; nextBefore: string | null; range: RangeName; degraded: string[]; truncated: boolean; generatedAt: string }
export interface IncidentPage { items: IncidentBrief[]; page: number; pageSize: number; total: number; pages: number; degraded: string[] }

export interface IncidentDetail extends IncidentBrief {
  evidence: { label: string; value: string; source?: string }[];
  timeline: { at: string; kind: string; note: string }[];
  orderKeys: string[];
  orders: OrderRow[];
  nextSteps: { text: string; href?: string }[];
  events: ReliabilityEvent[];
  affectedComponents: ComponentId[];
}

export type StageState = "done" | "pending" | "waiting" | "failed" | "skipped" | "unknown" | "not_linked";
export interface TraceStage {
  id: string;
  label: string;
  state: StageState;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  waitingMs?: number | null;
  retries: number | null;
  error: string | null;
  delayed: { limitMs: number; exceeded: boolean } | null;
  basis: "recorded" | "inferred" | "missing";
  source: string | null;
  note: string | null;
}

export interface OrderTrace {
  key: string;
  orderId: string;
  user: string | null;
  plan: string | null;
  status: string;
  recovery: { status: string; reason: string | null };
  stages: TraceStage[];
  transitions: { at: string | null; type: string; from: string | null; to: string | null }[];
  events: ReliabilityEvent[];
  generatedAt: string;
}

export interface OrderList { rows: OrderRow[]; truncated: boolean; scope: "unresolved" | "customer" }

export interface HistoryPoint { t: string; measured: number; requests: number | null; errors: number | null; timeouts: number | null; p95Ms: number | null; providerP95Ms: number | null; health: Partial<Record<ComponentId, HealthState>> }
export interface History { range: RangeName; generatedAt: string; bucketMs: number; points: HistoryPoint[]; components: { id: ComponentId; label: string }[]; metrics: WindowMetrics | null }

export const RANGES: { value: RangeName; label: string; long: string }[] = [
  { value: "15m", label: "15m", long: "last 15 minutes" },
  { value: "1h", label: "1h", long: "last hour" },
  { value: "6h", label: "6h", long: "last 6 hours" },
  { value: "24h", label: "24h", long: "last 24 hours" },
];

export const STATE_LABEL: Record<HealthState, string> = { healthy: "Healthy", degraded: "Degraded", failed: "Failed", stale: "Stale", unknown: "Unknown" };
/** Tones of the shared `.mf-signal` dot. */
export const STATE_TONE: Record<HealthState, "ok" | "warn" | "bad" | "idle"> = { healthy: "ok", degraded: "warn", failed: "bad", stale: "warn", unknown: "idle" };
export const STATE_VARIANT: Record<HealthState, "success" | "warning" | "destructive" | "muted"> = { healthy: "success", degraded: "warning", failed: "destructive", stale: "warning", unknown: "muted" };
export const STATE_MEANING: Record<HealthState, string> = {
  healthy: "Recent positive evidence that it works.",
  degraded: "Working, with evidence of a problem.",
  failed: "Evidence that it is not working.",
  stale: "Checked, but too long ago to describe now.",
  unknown: "No evidence either way. Silence is not health.",
};
export const SEVERITY_LABEL: Record<IncidentSeverity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
export const SEVERITIES: IncidentSeverity[] = ["critical", "high", "medium", "low"];
export const SEVERITY_VARIANT: Record<IncidentSeverity, "destructive" | "warning" | "muted"> = { critical: "destructive", high: "destructive", medium: "warning", low: "muted" };
export const EVENT_SEVERITY_LABEL: Record<EventSeverity, string> = { critical: "Critical", error: "Error", warning: "Warning", info: "Info", debug: "Debug" };
export const EVIDENCE_LABEL: Record<ComponentHealth["evidence"], string> = { probe: "Active check", process: "Measured in this process", traffic: "Observed traffic", records: "Stored records", config: "Configuration only", none: "No evidence yet" };
export const STAGE_LABEL: Record<StageState, string> = { done: "Done", pending: "In progress", waiting: "Waiting", failed: "Failed", skipped: "Not reached", unknown: "Unknown", not_linked: "Not linked" };
export const BASIS_LABEL: Record<TraceStage["basis"], string> = { recorded: "Recorded", inferred: "Inferred", missing: "No telemetry" };
export const ORDER_STATUS_LABEL: Record<string, string> = {
  reserving: "Reserving funds", reserved: "Reserved", provisioning: "Provisioning", provisioned: "Provisioned", uncertain: "Provider result unknown",
  manual_review: "Needs review", awaiting_provider: "Awaiting provider funds", refund_pending: "Refund pending", completed: "Delivery pending", refunded: "Refunded", failed: "Failed",
};
export const EVENT_TYPES = [
  { value: "webhook", label: "Payment callbacks" },
  { value: "provider", label: "Provider requests" },
  { value: "order", label: "Order stages" },
  { value: "payment", label: "Payment stages" },
  { value: "delivery", label: "Telegram delivery" },
  { value: "dependency", label: "Health changes" },
  { value: "job", label: "Background jobs" },
  { value: "incident", label: "Incidents" },
  { value: "polling", label: "Polling" },
];

const EVENT_ORDER: EventSeverity[] = ["critical", "error", "warning", "info", "debug"];

/** Stable ids, newest first, capped. A repeat, a late arrival and a coalesced update all land on the same row. */
export function mergeEvents(current: ReliabilityEvent[], incoming: ReliabilityEvent[], limit = 200): ReliabilityEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, limit);
}

export interface EventFilters { severity?: string; component?: string; type?: string; since?: number }

export function matchesFilters(event: ReliabilityEvent, filters: EventFilters): boolean {
  if (filters.severity && EVENT_ORDER.indexOf(event.severity) > EVENT_ORDER.indexOf(filters.severity as EventSeverity)) return false;
  if (filters.component && event.component !== filters.component) return false;
  if (filters.type && event.type !== filters.type && !event.type.startsWith(`${filters.type}.`)) return false;
  if (filters.since && new Date(event.at).getTime() < filters.since) return false;
  return true;
}

export const RECONNECT_BASE_MS = 2_000;
export const RECONNECT_MAX_MS = 60_000;
/** The server pings every 15 seconds, so two missed pings mean the stream can no longer be called live. */
export const STREAM_SILENCE_MS = 40_000;
export const CONNECTION_LOST_MS = 90_000;

export function reconnectDelayMs(failures: number): number {
  return failures <= 0 ? RECONNECT_BASE_MS : Math.min(RECONNECT_BASE_MS * 2 ** failures, RECONNECT_MAX_MS);
}

export type ConnectionState = "connecting" | "live" | "polling" | "reconnecting" | "stale" | "disconnected" | "paused" | "signed_out";

export const CONNECTION_LABEL: Record<ConnectionState, { label: string; tone: "ok" | "warn" | "bad" | "idle"; detail: string }> = {
  connecting: { label: "Connecting", tone: "idle", detail: "Opening the live connection." },
  live: { label: "Live", tone: "ok", detail: "Connected, and the monitor ran recently." },
  polling: { label: "Polling", tone: "warn", detail: "The stream is unavailable, so this page is asking for updates." },
  reconnecting: { label: "Reconnecting", tone: "warn", detail: "The connection dropped. Showing the last data received." },
  stale: { label: "Stale", tone: "bad", detail: "Connected, but the monitor has not reported recently. Nothing here describes now." },
  disconnected: { label: "Disconnected", tone: "bad", detail: "No connection to the server. Showing the last data received." },
  paused: { label: "Paused while hidden", tone: "idle", detail: "Updates resume when this tab is visible." },
  signed_out: { label: "Signed out", tone: "bad", detail: "This session ended. Sign in again to see live data." },
};

export interface ConnectionFacts {
  transport: "stream" | "polling" | "none";
  lastMessageAt: number | null;
  failures: number;
  paused: boolean;
  signedOut: boolean;
  snapshotFresh: boolean;
  now: number;
}

/** "Live" needs a connection that spoke recently and a monitor that ran recently. Either one alone is not enough. */
export function connectionState({ transport, lastMessageAt, failures, paused, signedOut, snapshotFresh, now }: ConnectionFacts): ConnectionState {
  if (signedOut) return "signed_out";
  if (paused) return "paused";
  if (lastMessageAt == null) return failures > 0 ? "disconnected" : "connecting";
  const silence = now - lastMessageAt;
  if (silence > CONNECTION_LOST_MS) return "disconnected";
  if (transport === "none") return "reconnecting";
  if (silence > STREAM_SILENCE_MS && transport === "stream") return "reconnecting";
  if (!snapshotFresh) return "stale";
  return transport === "polling" ? "polling" : "live";
}

/** Whether the data in hand says anything about now. The server says so; a client clock only ever makes it worse. */
export function snapshotIsFresh(snapshot: Snapshot | null, now: number): boolean {
  if (!snapshot?.monitoring.lastTickAt || snapshot.monitoring.fresh === false) return false;
  return now - new Date(snapshot.monitoring.lastTickAt).getTime() <= Math.max(snapshot.monitoring.intervalSeconds * 3_000, 45_000) + 15_000;
}

/**
 * What the page may claim when the data in hand no longer describes now. A monitor can die while the stream keeps answering
 * pings, so nothing pushes a correction: without this the last "healthy" would stay on screen under a warning.
 */
export function staleView(snapshot: Snapshot, connection: ConnectionState): Snapshot {
  if ((connection !== "stale" && connection !== "disconnected") || snapshot.overall.state === "stale") return snapshot;
  const reason = connection === "stale" ? "The monitor stopped reporting, so nothing here describes the system now." : "No connection to the server, so nothing here describes the system now.";
  return {
    ...snapshot,
    overall: { state: "stale", reason, affected: [], unverified: snapshot.components.map((item) => item.id) },
    components: snapshot.components.map((item) => ({ ...item, state: "stale", reason: `Last known: ${item.state}. ${item.reason}` })),
    edges: snapshot.edges.map((edge) => ({ ...edge, count: null, perMinute: null, measured: false })),
  };
}

export const VIEW_WIDTH = 1000;
export const VIEW_HEIGHT = 520;

interface Point { x: number; y: number }

/** Names short enough for a node face at laptop width. The inspector and the list use the full ones. */
export const NODE_LABEL: Record<ComponentId, string> = {
  telegram: "Telegram API", hooshpay: "HooshPay", nowpayments: "NOWPayments", wizardxray: "WizardXray", polling: "Polling loop", express: "Express app",
  webhook: "Webhook path", orders: "Orders", delivery: "Delivery", jobs: "Jobs", mongodb: "MongoDB", redis: "Redis",
};

export const NODE_POSITION: Record<ComponentId, Point> = {
  telegram: { x: 95, y: 78 },
  hooshpay: { x: 95, y: 250 },
  nowpayments: { x: 95, y: 372 },
  polling: { x: 305, y: 78 },
  webhook: { x: 305, y: 312 },
  express: { x: 305, y: 452 },
  orders: { x: 520, y: 160 },
  jobs: { x: 520, y: 372 },
  wizardxray: { x: 735, y: 78 },
  delivery: { x: 905, y: 200 },
  mongodb: { x: 735, y: 312 },
  redis: { x: 735, y: 452 },
};

function curve(from: Point, to: Point): string {
  const bend = Math.max(50, Math.abs(to.x - from.x) * 0.45);
  const direction = to.x >= from.x ? 1 : -1;
  return `M ${from.x} ${from.y} C ${from.x + bend * direction} ${from.y}, ${to.x - bend * direction} ${to.y}, ${to.x} ${to.y}`;
}

/** Routes that would otherwise run straight through a node. */
const CUSTOM_PATH: Record<string, string> = {
  "delivery-telegram": "M 905 200 C 905 -30, 300 -30, 95 78",
  "express-webhook": "M 305 452 L 305 312",
  "polling-redis": "M 305 78 C 330 280, 560 470, 735 452",
};

export function edgePath(edge: Pick<TopologyEdge, "id" | "from" | "to">): string {
  return CUSTOM_PATH[edge.id] ?? curve(NODE_POSITION[edge.from], NODE_POSITION[edge.to]);
}

/** Log scale, and few: a busy link looks busier, the screen never fills with dots, and silence draws none at all. */
export function trafficDots(edge: Pick<TopologyEdge, "kind" | "measured" | "count">): number {
  if (edge.kind !== "flow" || !edge.measured || !edge.count || edge.count <= 0) return 0;
  return Math.min(4, 1 + Math.floor(Math.log10(edge.count) * 1.5));
}

const WIDTHS = { idle: 1.25, active: 2.5 };
export function edgeWidth(edge: Pick<TopologyEdge, "measured" | "count">): number {
  if (!edge.measured || !edge.count) return WIDTHS.idle;
  return Math.min(4.5, WIDTHS.active + Math.log10(edge.count + 1) * 0.8);
}

/** What selecting something lights up. A node: itself and what touches it. An incident: everything it can reach. */
export function highlightSet(edges: Pick<TopologyEdge, "id" | "from" | "to">[], selection: { node?: ComponentId | null; path?: ComponentId[] | null }): { nodes: Set<ComponentId>; edges: Set<string> } | null {
  if (selection.path?.length) {
    const nodes = new Set<ComponentId>(selection.path);
    return { nodes, edges: new Set(edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to)).map((edge) => edge.id)) };
  }
  if (!selection.node) return null;
  const touching = edges.filter((edge) => edge.from === selection.node || edge.to === selection.node);
  const nodes = new Set<ComponentId>([selection.node]);
  for (const edge of touching) { nodes.add(edge.from); nodes.add(edge.to); }
  return { nodes, edges: new Set(touching.map((edge) => edge.id)) };
}

export function formatPercent(rate: number | null): string {
  if (rate == null) return "—";
  const percent = rate * 100;
  if (percent === 0 || percent === 100) return `${percent}%`;
  if (percent < 0.1) return "<0.1%";
  return `${percent.toFixed(percent < 10 ? 2 : 1)}%`;
}

export function formatRate(perMinute: number): string {
  if (perMinute === 0) return "0";
  return perMinute < 10 ? perMinute.toFixed(perMinute < 1 ? 2 : 1) : String(Math.round(perMinute));
}

/** Histogram values are upper bounds, so they read "≤". Raw record durations are exact. */
export function formatPercentile(value: Percentile | null, { exact = false }: { exact?: boolean } = {}): string {
  if (!value) return "—";
  if (value.over) return ">60 s";
  if (value.valueMs == null) return "—";
  const ms = value.valueMs;
  const text = ms < 1_000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${(ms / 60_000).toFixed(1)} min`;
  return exact ? text : `≤${text}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 172_800_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}

export function formatCoverage(coverage: WindowMetrics["coverage"]): string {
  if (coverage.ratio >= 0.995) return "Full window observed";
  if (!coverage.observedMinutes) return "No telemetry in this window";
  return `${formatDuration(coverage.observedMinutes * 60_000)} of ${formatDuration(coverage.expectedMinutes * 60_000)} observed`;
}
