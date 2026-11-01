/**
 * The vocabulary of the Service Reliability Center: the real components of this process and how they depend on each other,
 * the time windows, and the job schedule. Everything listed here was traced in the code; docs/reliability.md says from where.
 */
export const RELIABILITY_JOB = "service-reliability";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * healthy  - positive evidence, recent enough to trust
 * degraded - working, with evidence of a problem
 * failed   - evidence it is not working
 * stale    - it was checked, but the last check is too old to say anything about now
 * unknown  - no evidence either way. Silence is reported here, never as healthy
 */
export const HEALTH_STATES = Object.freeze(["healthy", "degraded", "failed", "stale", "unknown"]);
export const STATE_RANK = Object.freeze({ failed: 0, degraded: 1, stale: 2, unknown: 3, healthy: 4 });

export const WINDOWS = Object.freeze({
  "15m": { ms: 15 * MINUTE, bucketMs: MINUTE, label: "15 minutes" },
  "1h": { ms: HOUR, bucketMs: 2 * MINUTE, label: "1 hour" },
  "6h": { ms: 6 * HOUR, bucketMs: 10 * MINUTE, label: "6 hours" },
  "24h": { ms: 24 * HOUR, bucketMs: 30 * MINUTE, label: "24 hours" },
});

/** How long positive evidence from traffic lasts. */
export const EVIDENCE_WINDOW_MS = 6 * HOUR;
/** The webhook and delivery checks run real paths, so they run rarely. Their evidence still has to be recent. */
export const RARE_PROBE_MS = 10 * MINUTE;

/** Percentiles below these sample counts are withheld: with 8 samples, "P99" is only the maximum under another name. */
export const PERCENTILE_MIN_SAMPLES = Object.freeze({ p50: 5, p95: 20, p99: 100 });
/** Rates below this many observations are shown as counts. */
export const RATE_MIN_SAMPLES = 5;

/**
 * `dependsOn` is what a component needs in order to work, and is acyclic; it drives the blast radius of an incident.
 * `critical`: customers cannot be served without it, so its failure is the overall failure.
 */
export const COMPONENTS = Object.freeze([
  { id: "telegram", label: "Telegram Bot API", group: "External", critical: true, dependsOn: [], role: "Delivers customer messages to the bot and carries its replies." },
  { id: "hooshpay", label: "HooshPay", group: "External", critical: false, dependsOn: [], role: "Payment provider. It calls our webhook when an invoice changes." },
  { id: "nowpayments", label: "NOWPayments", group: "External", critical: false, dependsOn: [], role: "Crypto payment provider. It sends signed IPN callbacks." },
  { id: "wizardxray", label: "WizardXray", group: "External", critical: true, dependsOn: [], role: "VPN panel. Creates the service an order pays for." },
  { id: "polling", label: "Polling loop", group: "This process", critical: true, dependsOn: ["telegram", "redis"], role: "The single long-poll that receives every Telegram update." },
  { id: "express", label: "Express app", group: "This process", critical: true, dependsOn: [], role: "HTTP server for webhooks, the storefront and this panel." },
  { id: "webhook", label: "Webhook path", group: "This process", critical: false, dependsOn: ["express", "mongodb", "redis"], role: "Verifies provider callbacks, then credits the wallet." },
  { id: "orders", label: "Order workflow", group: "This process", critical: true, dependsOn: ["polling", "mongodb", "redis", "wizardxray"], role: "Reserves funds, creates the service and finalizes the order." },
  { id: "delivery", label: "Telegram delivery", group: "This process", critical: false, dependsOn: ["orders", "telegram"], role: "Sends the finished service to the customer through a durable outbox." },
  { id: "jobs", label: "Background jobs", group: "This process", critical: false, dependsOn: ["mongodb", "redis"], role: "Recovery crons, the TRX scanner, invoice cleanup and reconciliation." },
  { id: "mongodb", label: "MongoDB", group: "Data", critical: true, dependsOn: [], role: "The only authority for money and orders." },
  { id: "redis", label: "Redis", group: "Data", critical: true, dependsOn: [], role: "Sessions, locks and leases. Never trusted for balances." },
]);

export const COMPONENT_IDS = Object.freeze(COMPONENTS.map((item) => item.id));

/**
 * What the topology draws. `flow` edges carry measured traffic, and name the series that measures it; `uses` edges are
 * dependencies nothing counts, so they stay still. Moving dots appear on a flow edge only when its series saw traffic.
 */
export const EDGES = Object.freeze([
  { id: "telegram-polling", from: "telegram", to: "polling", kind: "flow", series: ["telegram.update"], unit: "updates", label: "Customer updates" },
  { id: "polling-orders", from: "polling", to: "orders", kind: "flow", records: "ordersCreated", unit: "orders", label: "Orders started" },
  { id: "orders-wizardxray", from: "orders", to: "wizardxray", kind: "flow", series: ["provider.wizardxray.create"], unit: "requests", label: "Service creation" },
  { id: "orders-delivery", from: "orders", to: "delivery", kind: "flow", records: "ordersDelivered", unit: "orders", label: "Finished orders" },
  { id: "delivery-telegram", from: "delivery", to: "telegram", kind: "flow", series: ["telegram.delivery"], unit: "messages", label: "Service messages", tone: "return" },
  { id: "hooshpay-webhook", from: "hooshpay", to: "webhook", kind: "flow", series: ["webhook.hooshpay"], unit: "callbacks", label: "Signed callbacks" },
  { id: "nowpayments-webhook", from: "nowpayments", to: "webhook", kind: "flow", series: ["webhook.nowpayments"], unit: "callbacks", label: "Signed IPNs" },
  { id: "express-webhook", from: "express", to: "webhook", kind: "uses", label: "Hosts the route" },
  { id: "webhook-mongodb", from: "webhook", to: "mongodb", kind: "uses", label: "Wallet credit" },
  { id: "orders-mongodb", from: "orders", to: "mongodb", kind: "uses", label: "Order records" },
  { id: "orders-redis", from: "orders", to: "redis", kind: "uses", label: "Locks" },
  { id: "polling-redis", from: "polling", to: "redis", kind: "uses", label: "Sessions" },
  { id: "jobs-mongodb", from: "jobs", to: "mongodb", kind: "uses", label: "Leases and records" },
  { id: "jobs-redis", from: "jobs", to: "redis", kind: "uses", label: "Cron locks" },
]);

/** The schedules are those set by each job's own start function. A job not reporting by `everyMs` × 3 is overdue. */
export const JOBS = Object.freeze([
  { name: "hooshpay-recovery-cron", label: "HooshPay and order recovery", everyMs: 5 * MINUTE, enabled: () => true },
  { name: "nowpayments-recovery", label: "NOWPayments recovery", everyMs: 2 * MINUTE, enabled: () => true },
  { name: "trx-scanner", label: "TRX wallet scanner", everyMs: 5 * MINUTE, enabled: (env) => Boolean(env.TRX_WALLET) },
  { name: "invoice-cleanup", label: "Invoice cleanup", everyMs: 60 * MINUTE, enabled: () => true },
  { name: "user-spend-sweeper", label: "User spend sweeper", everyMs: 2 * MINUTE, enabled: (env) => String(env.USER_SPEND_SWEEPER ?? "").trim().toLowerCase() !== "off" },
  { name: "money-flow-sentinel", label: "Money Flow Sentinel", everyMs: 2 * MINUTE, enabled: (env) => String(env.SENTINEL_ENABLED ?? "").trim().toLowerCase() !== "off", intervalFrom: "SENTINEL_INTERVAL_SECONDS" },
]);

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function reliabilityEnabled(env = process.env) {
  return String(env.RELIABILITY_ENABLED ?? "").trim().toLowerCase() !== "off";
}

/** Out-of-range values fall back to the default: a typo must not turn monitoring off or make it hammer a provider. */
export function readReliabilityConfig(env = process.env) {
  return {
    enabled: reliabilityEnabled(env),
    intervalMs: boundedInt(env.RELIABILITY_INTERVAL_SECONDS, 30, 10, 300) * 1000,
    probeIntervalMs: boundedInt(env.RELIABILITY_PROBE_SECONDS, 60, 30, 600) * 1000,
  };
}

/** Everything that stops working if `component` stops: the component plus all that depends on it, directly or not. */
export function blastRadius(component) {
  const reached = new Set([component]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of COMPONENTS) {
      if (!reached.has(item.id) && item.dependsOn.some((id) => reached.has(id))) {
        reached.add(item.id);
        grew = true;
      }
    }
  }
  return [...reached];
}

export const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
