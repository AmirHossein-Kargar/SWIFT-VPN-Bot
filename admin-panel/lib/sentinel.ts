/**
 * Money Flow Sentinel in the browser: API shapes, labels, and the pure logic of the live feed and the flow graph.
 * Nothing here decides anything about money; every number and severity comes from the server.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Classification = "confirmed" | "probable" | "informational";
export type Review = "new" | "investigating" | "remediation_proposed" | "resolved" | "false_positive";
export type Direction = "owed_to_customer" | "excess_in_wallet" | "held" | "none";
export type SyncHealth = "healthy" | "delayed" | "stale" | "never_run" | "disabled";
export type StageState = "done" | "pending" | "failed" | "skipped" | "contradiction";

export interface SyncStatus {
  enabled: boolean;
  health: SyncHealth;
  intervalSeconds: number;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastPassCompletedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  passUsers: number;
  totalUsers: number | null;
  leaseHeld: boolean;
}

export interface FindingSummary {
  id: string;
  code: string;
  title: string;
  category: string;
  classification: Classification;
  severity: Severity;
  user: string | null;
  subjectType: string;
  subject: string;
  amountToman: number;
  direction: Direction;
  expected: string | null;
  observed: string | null;
  state: "open" | "cleared";
  review: Review;
  firstDetectedAt: string;
  lastDetectedAt: string;
  clearedAt: string | null;
  detections: number;
  reopenCount: number;
}

export interface Exposure { owedToCustomers: number; excessInWallets: number; affectedUsers: number }
export interface LatencyStats { samples: number; p50Ms: number | null; p95Ms: number | null }
export interface Amounted { count: number; amount: number }

export interface SentinelOverview {
  generatedAt: string;
  range: string;
  bucket: "hour" | "day";
  timeZone: string;
  activity: { series: { t: string; inflow: number; consumed: number; refunded: number }[]; totals: { inflow: Amounted; consumed: Amounted; refunded: Amounted } } | null;
  held: Amounted | null;
  latency: { credit: LatencyStats; fulfilment: LatencyStats } | null;
  findings: { bySeverity: Record<Severity, number>; byClassification: Record<Classification, number>; exposure: Exposure; exposureTruncated: boolean } | null;
  recentFindings: FindingSummary[];
  sync: SyncStatus | null;
  degraded: string[];
}

export interface ProviderCohort { provider: string; label: string; initiated: Amounted; confirmed: Amounted; credited: Amounted }
export interface SentinelFlow {
  generatedAt: string;
  range: string;
  provider: string;
  from: string;
  payments: ProviderCohort[] | null;
  orders: { reserved: Amounted; held: Amounted; fulfilled: Amounted; refunded: Amounted; failed: Amounted } | null;
  admin: { added: Amounted; removed: Amounted } | null;
  anomalies: Record<string, { count: number; rank: number }>;
  degraded: string[];
}

export interface FeedEvent {
  id: string;
  key: string;
  kind: "payment" | "order";
  provider: string;
  stage: string;
  at: string;
  amount: number | null;
  currency: string;
  user: string | null;
  status: string;
  source: string;
  basis: "recorded" | "inferred";
}

export interface LiveFeed {
  events: FeedEvent[];
  serverTime: string;
  nextSince: string;
  truncated: boolean;
  degraded: string[];
  openFindings: number | null;
}

export interface TransactionRow {
  key: string;
  kind: "payment" | "order";
  provider: string;
  providerLabel: string;
  label: string;
  amount: number | null;
  currency: string;
  payCurrency: string | null;
  user: string | null;
  status: string;
  createdAt: string | null;
  anomaly: { severity: Severity; count: number } | null;
}

export interface TransactionPage { items: TransactionRow[]; nextBefore: string | null; pageSize: number; degraded: string[] }

export interface FlowStage { stage: string; state: StageState; at: string | null; source: string; detail: string | null; basis: "recorded" | "inferred" }
export interface Relationship { from: string; to: string; type: string; basis: "recorded" | "inferred" | "absent"; evidence: string }
export interface WalletEntry { id: string; type: string; at: string | null; delta: number | null; ref: string; ledgerKey: string; basis: string; balanceAfter: number | null }
export interface WalletView {
  available: boolean;
  balance?: number | null;
  expected?: number;
  drift?: number | null;
  coverage?: "complete" | "partial";
  totals?: Record<string, number>;
  counts?: Record<string, number>;
  unkeyed?: Record<string, number>;
  uncountedCredits?: number;
  unresolved?: number;
  entries?: WalletEntry[];
}

export interface TransactionDetail {
  key: string;
  kind: "payment" | "order";
  provider: string;
  providerLabel: string;
  amount: number | null;
  currency: string;
  status: string;
  createdAt: string | null;
  userId: string;
  user: string | null;
  identifiers: Record<string, string | number | null>;
  verification: { providerStatus: string; confirmed: boolean; ledgerVersion: number | null; callbacks: { at: string; status: string }[]; retryCount: number; lastErrorCode: string | null } | null;
  order: { walletDebitStatus: string | null; refundStatus: string; refundAmount: number | null; refundReason: string | null; errorCode: string | null; retryCount: number; transitions: { at: string | null; type: string | null; from: string | null; to: string | null }[] } | null;
  recovery: { status: string; reason: string | null };
  flow: FlowStage[];
  relationships: Relationship[];
  wallet: WalletView;
  findings: FindingSummary[];
}

export interface RemediationOption { id: string; label: string; tool: string | null; href: string | null; risk: "none" | "low" | "medium" | "high"; consequence: string; amountToman?: number | null }
export interface ReviewEntry { at: string; actor: string; from: string; to: string; reason: string; optionId: string | null }

export interface FindingDetail extends Omit<FindingSummary, "subject"> {
  userId: string;
  subject: string;
  subjectHref: string | null;
  expectedToman: number | null;
  observedToman: number | null;
  facts: Record<string, unknown>;
  refs: { type: string; key: string }[];
  reviewHistory: ReviewEntry[];
  explanation: { title: string; why: string | null; likelyCause: string | null; options: RemediationOption[] };
  revalidation: { checkedAt: string; stillReproduces: boolean; expected: string | null; observed: string | null; amountToman: number | null; otherLiveProblems: number };
  impact: { thisFinding: number; direction: Direction; customer: Exposure; note: string };
  timeline: FeedEvent[];
  wallet: WalletView;
  related: FindingSummary[];
}

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };
export const CLASSIFICATION_LABEL: Record<Classification, string> = { confirmed: "Confirmed", probable: "Probable", informational: "Informational" };
export const REVIEW_LABEL: Record<Review, string> = { new: "New", investigating: "Investigating", remediation_proposed: "Fix proposed", resolved: "Resolved", false_positive: "Dismissed" };
export const STAGE_LABEL: Record<string, string> = {
  initiated: "Payment initiated",
  confirmed: "Provider confirmed",
  credited: "Wallet credited",
  reserved: "Funds reserved",
  provisioning: "Provisioning started",
  awaiting_provider: "Awaiting provider funds",
  fulfilled: "Service delivered",
  refund_requested: "Refund requested",
  refunded: "Refund applied",
  reversed: "Provider reversed",
  failed: "Failed",
  callback: "Provider callback",
};
export const DIRECTION_LABEL: Record<Direction, string> = { owed_to_customer: "Owed to the customer", excess_in_wallet: "Excess in the wallet", held: "Held", none: "No money at stake" };
export const RANGE_OPTIONS = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];
export const PROVIDER_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "hooshpay", label: "HooshPay" },
  { value: "nowpayments", label: "NOWPayments" },
  { value: "bank", label: "Bank transfer" },
  { value: "trx", label: "TRX (legacy)" },
  { value: "wallet", label: "Wallet orders" },
];

/** Stable ids, newest first, capped: a poll may repeat events or deliver them late and the result is the same. */
export function mergeFeedEvents(current: FeedEvent[], incoming: FeedEvent[], limit = 150): FeedEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, limit);
}

export const FEED_INTERVAL_MS = 10_000;
const FEED_MAX_BACKOFF_MS = 60_000;
/** Each cursor reaches back by this much, so an event written just behind the last poll is not lost. */
export const FEED_OVERLAP_MS = 120_000;

export function feedDelayMs(failures: number): number {
  return failures <= 0 ? FEED_INTERVAL_MS : Math.min(FEED_INTERVAL_MS * 2 ** failures, FEED_MAX_BACKOFF_MS);
}

export function overlapCursor(nextSince: string): string {
  return new Date(new Date(nextSince).getTime() - FEED_OVERLAP_MS).toISOString();
}

export type FeedHealth = "connecting" | "live" | "delayed" | "stale" | "paused";

/** Live means a successful poll recently, and nothing else. Failures show up here instead of old data looking current. */
export function feedHealth({ lastSyncAt, paused, now }: { lastSyncAt: number | null; paused: boolean; now: number }): FeedHealth {
  if (paused) return "paused";
  if (lastSyncAt == null) return "connecting";
  const age = now - lastSyncAt;
  if (age <= FEED_INTERVAL_MS * 2.5) return "live";
  return age <= FEED_INTERVAL_MS * 9 ? "delayed" : "stale";
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function formatSpan(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export type FlowNodeId = "hooshpay" | "nowpayments" | "trx" | "bank" | "confirmed" | "wallet" | "reserved" | "fulfilled" | "refunded" | "admin";

export interface FlowNode { id: FlowNodeId; label: string; count: number; amount: number; alert: Severity | null; x: number; y: number; hint: string }
export interface FlowEdge { id: string; from: FlowNodeId; to: FlowNodeId; count: number; path: string; particles: number; tone: "normal" | "return" }

const RANK_SEVERITY: Severity[] = ["critical", "high", "medium", "low", "info"];
const VIEW = { confirmedX: 330, walletX: 520, reservedX: 700, outcomeX: 905 };

/** Log scale: a busy edge looks busier, but the screen never fills with dots. */
export function particleCount(count: number): number {
  if (count <= 0) return 0;
  return Math.min(5, 1 + Math.floor(Math.log10(count + 1) * 1.6));
}

function curve(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const bend = Math.max(60, Math.abs(to.x - from.x) * 0.45);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

/** The graph for one cohort. Node amounts belong to their own stage: they are never summed across stages. */
export function buildFlowGraph(flow: SentinelFlow): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const payments = flow.payments ?? [];
  const orders = flow.orders;
  const provider = (id: string) => payments.find((item) => item.provider === id);
  const sum = (pick: (item: ProviderCohort) => Amounted) => payments.reduce((total, item) => ({ count: total.count + pick(item).count, amount: total.amount + pick(item).amount }), { count: 0, amount: 0 });
  const confirmed = sum((item) => item.confirmed);
  const credited = sum((item) => item.credited);
  const alert = (...categories: string[]): Severity | null => {
    const ranks = categories.map((name) => flow.anomalies[name]?.rank).filter((rank): rank is number => rank != null);
    return ranks.length ? RANK_SEVERITY[Math.min(...ranks)] ?? null : null;
  };
  const source = (id: FlowNodeId, label: string, y: number): FlowNode => ({ id, label, y, x: 95, count: provider(id)?.initiated.count ?? 0, amount: provider(id)?.initiated.amount ?? 0, alert: null, hint: "Payments initiated" });
  const nodes: FlowNode[] = [
    source("hooshpay", "HooshPay", 70),
    source("nowpayments", "NOWPayments", 170),
    source("trx", "TRX", 270),
    source("bank", "Bank", 370),
    { id: "confirmed", label: "Confirmed", x: VIEW.confirmedX, y: 220, ...confirmed, alert: alert("payment"), hint: "Confirmed by the provider" },
    { id: "wallet", label: "Wallets", x: VIEW.walletX, y: 220, ...credited, alert: alert("wallet"), hint: "Credited to customer wallets" },
    { id: "reserved", label: "Reserved", x: VIEW.reservedX, y: 150, count: orders?.reserved.count ?? 0, amount: orders?.reserved.amount ?? 0, alert: alert("order", "stuck", "transition"), hint: "Debited for orders" },
    { id: "fulfilled", label: "Delivered", x: VIEW.outcomeX, y: 80, count: orders?.fulfilled.count ?? 0, amount: orders?.fulfilled.amount ?? 0, alert: null, hint: "Service delivered" },
    { id: "refunded", label: "Refunded", x: VIEW.outcomeX, y: 240, count: orders?.refunded.count ?? 0, amount: orders?.refunded.amount ?? 0, alert: alert("refund"), hint: "Returned to wallets" },
    { id: "admin", label: "Admin", x: VIEW.walletX, y: 390, count: (flow.admin?.added.count ?? 0) + (flow.admin?.removed.count ?? 0), amount: (flow.admin?.added.amount ?? 0) + (flow.admin?.removed.amount ?? 0), alert: null, hint: "Audited balance changes" },
  ];
  const at = (id: FlowNodeId) => nodes.find((node) => node.id === id)!;
  const edge = (from: FlowNodeId, to: FlowNodeId, count: number, tone: FlowEdge["tone"] = "normal", path?: string): FlowEdge => ({
    id: `${from}-${to}`, from, to, count, tone, particles: particleCount(count), path: path ?? curve(at(from), at(to)),
  });
  const wallet = at("wallet");
  const refunded = at("refunded");
  return {
    nodes,
    edges: [
      ...(["hooshpay", "nowpayments", "trx", "bank"] as const).map((id) => edge(id, "confirmed", provider(id)?.confirmed.count ?? 0)),
      edge("confirmed", "wallet", credited.count),
      edge("wallet", "reserved", orders?.reserved.count ?? 0),
      edge("reserved", "fulfilled", orders?.fulfilled.count ?? 0),
      edge("reserved", "refunded", orders?.refunded.count ?? 0),
      edge("refunded", "wallet", orders?.refunded.count ?? 0, "return", `M ${refunded.x} ${refunded.y} C ${refunded.x - 40} 370, ${wallet.x + 170} 340, ${wallet.x} ${wallet.y}`),
      edge("admin", "wallet", at("admin").count, "normal", `M ${at("admin").x} ${at("admin").y} L ${wallet.x} ${wallet.y}`),
    ],
  };
}

/** Plain text a person can paste into a ticket. Uses the masked customer id: the report may travel further than the panel. */
export function findingReport(finding: FindingDetail): string {
  const lines = [
    `Money Flow Sentinel: ${finding.title}`,
    `Severity: ${SEVERITY_LABEL[finding.severity]} | Evidence: ${CLASSIFICATION_LABEL[finding.classification]} | Status: ${REVIEW_LABEL[finding.review]}`,
    `Customer: ${finding.user ?? "unknown"} | Record: ${finding.subject.replace(/user:\d+/g, `user:${finding.user ?? ""}`)}`,
    `First detected: ${finding.firstDetectedAt} | Rechecked: ${finding.revalidation.checkedAt} (${finding.revalidation.stillReproduces ? "still reproduces" : "no longer reproduces"})`,
    "",
    `Expected: ${finding.expected ?? "n/a"}`,
    `Observed: ${finding.observed ?? "n/a"}`,
    `Amount at stake: ${finding.amountToman.toLocaleString("en-US")} Toman (${DIRECTION_LABEL[finding.direction]})`,
    "",
    `Why it matters: ${finding.explanation.why ?? "n/a"}`,
    `Likely cause (not proven): ${finding.explanation.likelyCause ?? "n/a"}`,
    "",
    "Timeline:",
    ...finding.timeline.map((event) => `- ${event.at} ${STAGE_LABEL[event.stage] ?? event.stage} (${event.source})`),
    "",
    "Options:",
    ...finding.explanation.options.map((option) => `- ${option.label}: ${option.consequence}`),
  ];
  return lines.join("\n");
}
