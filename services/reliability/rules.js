/**
 * Incident detection. Pure: a list of conditions true right now, plus the rule groups that could not be evaluated.
 *
 * That second list matters. If MongoDB is down the order counts cannot be read, and a rule that sees "no count" would look
 * like a recovery. An unevaluated group holds its open incidents as they are: missing telemetry never resolves anything.
 */
import { SEVERITY_RANK, WINDOWS } from "./constants.js";
import { sumSeries } from "./metrics.js";

const RECENT_MS = WINDOWS["15m"].ms;
const CONSECUTIVE_FAILURES = 2;
const REJECTED_BURST = 10;
const MIN_FAILURES = 3;

function condition({ code, subject = "all", group, component, severity, title, summary, evidence = [], affectedOrders = null, orderKeys = [] }) {
  return { fingerprint: `${code}:${subject}`.slice(0, 96), code, group: group ?? code, component, severity, rank: SEVERITY_RANK[severity], title, summary, evidence: evidence.slice(0, 8), affectedOrders, orderKeys: orderKeys.slice(0, 20) };
}

const DEPENDENCY = [
  { id: "mongodb", label: "MongoDB", severity: "critical", impact: "Payments and orders cannot be recorded." },
  { id: "redis", label: "Redis", severity: "high", impact: "Sessions, locks and this panel's sign-in depend on it. Money stays safe on MongoDB guards." },
  { id: "telegram", label: "Telegram Bot API", severity: "critical", impact: "Customers cannot reach the bot, and deliveries wait in the outbox." },
  { id: "wizardxray", label: "WizardXray", severity: "high", impact: "New orders cannot be provisioned." },
  { id: "express", label: "Express app", severity: "critical", impact: "Webhooks and this panel depend on it." },
  { id: "hooshpay", label: "HooshPay", severity: "high", impact: "Customers may not be able to top up, and payment checks cannot complete." },
  { id: "nowpayments", label: "NOWPayments", severity: "high", impact: "Customers may not be able to top up with crypto." },
  { id: "webhook", label: "Webhook path", severity: "high", impact: "A real provider callback would fail the same way, so credits would wait for recovery." },
];

function dependencyConditions({ probes, components, conditions, unevaluated }) {
  const byId = new Map(components.map((item) => [item.id, item]));
  for (const dependency of DEPENDENCY) {
    const group = `dependency:${dependency.id}`;
    const probe = probes[dependency.id];
    const component = byId.get(dependency.id);
    if (!probe || component?.state === "stale" || component?.state === "unknown") { unevaluated.push(group); continue; }
    const evidence = [
      { label: "Last check", value: component.reason, source: "Health probe" },
      ...(probe.failures ? [{ label: "Consecutive failures", value: String(probe.failures), source: "Health probe" }] : []),
      ...(probe.lastSuccessAt ? [{ label: "Last success", value: new Date(probe.lastSuccessAt).toISOString(), source: "Health probe" }] : []),
    ];
    // One failed probe can be a blip; an incident needs two in a row.
    if (component.state === "failed" && (dependency.id === "telegram" ? true : probe.failures >= CONSECUTIVE_FAILURES)) {
      conditions.push(condition({ code: "DEPENDENCY_DOWN", subject: dependency.id, group, component: dependency.id, severity: dependency.severity, title: `${dependency.label} is not responding`, summary: dependency.impact, evidence }));
    } else if (component.state === "degraded") {
      conditions.push(condition({ code: "DEPENDENCY_DEGRADED", subject: dependency.id, group, component: dependency.id, severity: "medium", title: `${dependency.label} is degraded`, summary: component.reason, evidence }));
    }
  }
}

function pollingConditions({ polling, conditions, unevaluated }) {
  if (!polling) { unevaluated.push("polling"); return; }
  const evidence = [
    { label: "Last error", value: polling.lastErrorAgeSec == null ? "none" : `${polling.lastErrorAgeSec} s ago`, source: "getPollingEvidence" },
    { label: "Last completed poll", value: polling.lastSuccessAgeSec == null ? "none yet" : `${polling.lastSuccessAgeSec} s ago`, source: "getPollingEvidence" },
  ];
  if (polling.failing && polling.lastErrorStatus === 409) {
    conditions.push(condition({ code: "POLLING_CONFLICT", group: "polling", component: "polling", severity: "critical", title: "Another process is polling with this bot token", summary: "Telegram answers 409 Conflict. Updates may go to the other process, not this one.", evidence }));
  } else if (polling.failing || polling.stalled) {
    conditions.push(condition({ code: polling.failing ? "POLLING_FAILING" : "POLLING_STALLED", group: "polling", component: "polling", severity: "high", title: polling.failing ? "Telegram long polling is failing" : "Telegram long polling has stalled", summary: "Customer messages are not arriving.", evidence }));
  }
}

function webhookConditions({ recent, providers, components, conditions, unevaluated }) {
  const pathProven = components.find((item) => item.id === "webhook")?.state === "healthy";
  const missing = providers.filter((item) => item.configured && !item.secretConfigured);
  for (const provider of missing) {
    conditions.push(condition({ code: "WEBHOOK_SECRET_MISSING", subject: provider.id, group: "webhook:config", component: "webhook", severity: "high", title: `${provider.label} webhook secret is missing`, summary: "Fail closed: every callback from this provider is being refused until the secret is set.", evidence: [{ label: "Secret configured", value: "No", source: "Environment" }] }));
  }
  for (const provider of ["hooshpay", "nowpayments"]) {
    const series = sumSeries(recent, [`webhook.${provider}`]);
    const evidence = [{ label: "Answered 5xx in 15 min", value: String(series.err), source: "Webhook route" }, { label: "Accepted in 15 min", value: String(series.ok), source: "Webhook route" }];
    // Failures stopping because callbacks stopped is not recovery. Only an answered callback can clear this, or a signed test
    // callback through the same route, which is evidence of the path and not an absence of traffic.
    if (series.n === 0 && !pathProven) unevaluated.push(`webhook:${provider}`);
    if (series.err >= MIN_FAILURES) conditions.push(condition({ code: "WEBHOOK_FAILURES", subject: provider, group: `webhook:${provider}`, component: "webhook", severity: "high", title: `${provider === "hooshpay" ? "HooshPay" : "NOWPayments"} callbacks are failing`, summary: "Our handler answered 5xx, so the gateway will retry. A credit may be delayed.", evidence }));
    if (series.rej >= REJECTED_BURST) conditions.push(condition({ code: "WEBHOOK_REJECTED_BURST", subject: provider, group: "webhook:traffic", component: "webhook", severity: "medium", title: `Burst of rejected ${provider === "hooshpay" ? "HooshPay" : "NOWPayments"} callbacks`, summary: "Unsigned, forged or mismatched callbacks. Nothing was credited.", evidence: [{ label: "Rejected in 15 min", value: String(series.rej), source: "Webhook route" }] }));
  }
}

function providerConditions({ recent, components, conditions, unevaluated }) {
  const PROVIDERS = [
    { series: ["provider.wizardxray.create", "provider.wizardxray.write"], subject: "wizardxray", component: "wizardxray", label: "WizardXray" },
    { series: ["provider.hooshpay"], subject: "hooshpay", component: "hooshpay", label: "HooshPay" },
    { series: ["provider.nowpayments"], subject: "nowpayments", component: "nowpayments", label: "NOWPayments" },
  ];
  for (const provider of PROVIDERS) {
    const series = sumSeries(recent, provider.series);
    const failures = series.err + series.tmo;
    const evidence = [{ label: "Requests in 15 min", value: String(series.n), source: "Outbound client" }, { label: "Failed", value: String(series.err), source: "Outbound client" }, { label: "Timed out", value: String(series.tmo), source: "Outbound client" }];
    const group = `provider:${provider.subject}`;
    // No traffic is no evidence, but a passing reachability check is. Without one, the incident waits for real traffic.
    if (series.n === 0 && components.find((item) => item.id === provider.component)?.state !== "healthy") unevaluated.push(group);
    if (series.tmo >= MIN_FAILURES) conditions.push(condition({ code: "PROVIDER_TIMEOUTS", subject: provider.subject, group, component: provider.component, severity: "high", title: `${provider.label} requests are timing out`, summary: "A timed-out mutation has an unknown outcome, so it is never replayed automatically.", evidence }));
    else if (failures >= MIN_FAILURES && failures / Math.max(1, series.n) >= 0.5) conditions.push(condition({ code: "PROVIDER_ERRORS", subject: provider.subject, group, component: provider.component, severity: "high", title: `${provider.label} requests are failing`, summary: "At least half of recent requests failed.", evidence }));
  }
}

function orderConditions({ probes, workflow, conditions, unevaluated }) {
  const probe = probes.orders;
  if (!probe || probe.status === "down" || !probe.details) { unevaluated.push("orders"); return; }
  const details = probe.details;
  const keysFor = (statuses) => (workflow?.backlog ?? []).filter((row) => statuses.includes(row.status)).map((row) => row.key);
  const add = (code, count, severity, title, summary, statuses) => {
    if (count > 0) conditions.push(condition({ code, group: "orders", component: code === "DELIVERY_PENDING" || code === "ADMIN_ALERTS_PENDING" ? "delivery" : "orders", severity, title, summary, affectedOrders: count, orderKeys: keysFor(statuses), evidence: [{ label: "Orders", value: String(count), source: "WalletPurchase" }] }));
  };
  add("ORDERS_NEED_REVIEW", details.needsReview, "high", "Orders need a manual decision", "WizardXray gave an ambiguous answer. The debit is held and the request is never replayed.", ["manual_review", "uncertain"]);
  add("ORDERS_STUCK_PROVISIONING", details.stalledProvisioning, "high", "Orders are stuck in provisioning", "Past the 10-minute limit with no outcome.", ["provisioning"]);
  add("ORDERS_INTERRUPTED", details.ledgerStalled, "high", "Orders are stuck in an interrupted ledger step", "These steps normally last seconds and persist only after a crash. The recovery job repairs them.", ["reserving", "reserved", "provisioned"]);
  add("REFUNDS_PENDING", details.refundPending, "high", "Refunds are pending", "Customers are waiting for money back.", ["refund_pending"]);
  add("ORDERS_AWAITING_PROVIDER", details.awaitingProvider, "medium", "Orders are waiting for WizardXray funds", "The provider wallet is short. Debits are held until it is funded.", ["awaiting_provider"]);
  add("DELIVERY_PENDING", details.deliveryPending, "medium", "Finished services are not delivered yet", "The service exists and the Telegram message is retrying from the outbox.", ["completed"]);
  add("ADMIN_ALERTS_PENDING", details.alertPending, "low", "Admin alerts are not delivered", "Reserved-order alerts are retrying from the outbox.", ["awaiting_provider"]);
}

function jobConditions({ jobs, conditions, unevaluated }) {
  for (const job of jobs) {
    // Job runs are known only to this process, so after a restart a job is unknown, which is not the same as fixed.
    if (job.state === "unknown") unevaluated.push(`job:${job.name}`);
    if (job.state === "failed" || job.state === "degraded") {
      const failing = job.consecutiveFailures > 0;
      conditions.push(condition({ code: failing ? "JOB_FAILING" : "JOB_OVERDUE", subject: job.name, group: `job:${job.name}`, component: "jobs", severity: failing && job.consecutiveFailures >= 2 ? "high" : "medium", title: `${job.label} ${failing ? "is failing" : "is overdue"}`, summary: job.reason, evidence: [{ label: "Last run", value: job.lastRunAt ?? "not since this process started", source: "recordJobRun" }, { label: "Expected every", value: `${Math.round(job.everyMs / 60_000)} min`, source: "Job schedule" }] }));
    }
  }
}

function sentinelConditions({ sentinel, conditions, unevaluated }) {
  if (!sentinel) { unevaluated.push("sentinel"); return; }
  if (sentinel.health === "stale" || sentinel.health === "delayed") {
    conditions.push(condition({ code: "SENTINEL_BEHIND", group: "sentinel", component: "jobs", severity: sentinel.health === "stale" ? "medium" : "low", title: `Money Flow Sentinel is ${sentinel.health}`, summary: "Reconciliation is behind, so financial findings may be out of date. No money is affected.", evidence: [{ label: "Last success", value: sentinel.lastSuccessAt ? new Date(sentinel.lastSuccessAt).toISOString() : "never", source: "JobCheckpoint" }, { label: "Last error", value: sentinel.lastError ?? "none", source: "JobCheckpoint" }] }));
  }
}

function monitoringConditions({ persistence, conditions }) {
  if (persistence.failures >= 3) {
    conditions.push(condition({ code: "TELEMETRY_NOT_PERSISTED", group: "monitoring", component: "mongodb", severity: "medium", title: "Telemetry is not being saved", summary: "Live values are still measured, but a restart would lose the recent history.", evidence: [{ label: "Failed writes in a row", value: String(persistence.failures), source: "Collector" }] }));
  }
}

function httpConditions({ recent, conditions }) {
  const series = sumSeries(recent, ["http.admin", "http.panel", "http.store", "http.support", "http.other"]);
  if (series.n >= 20 && series.err / series.n >= 0.05) {
    conditions.push(condition({ code: "HTTP_ERRORS", group: "http", component: "express", severity: series.err / series.n >= 0.25 ? "high" : "medium", title: "The server is answering with errors", summary: `${series.err} of ${series.n} requests answered 5xx in 15 minutes.`, evidence: [{ label: "5xx in 15 min", value: String(series.err), source: "HTTP middleware" }, { label: "Requests", value: String(series.n), source: "HTTP middleware" }] }));
  }
}

export function evaluateRules(input) {
  const { now, minutes, components, probes, polling, providers, jobs, workflow, sentinel, persistence } = input;
  const conditions = [];
  const unevaluated = [];
  const recent = minutes.filter((minute) => minute.t >= now - RECENT_MS);
  dependencyConditions({ probes, components, conditions, unevaluated });
  pollingConditions({ polling, conditions, unevaluated });
  webhookConditions({ recent, providers, components, conditions, unevaluated });
  providerConditions({ recent, components, conditions, unevaluated });
  orderConditions({ probes, workflow, conditions, unevaluated });
  jobConditions({ jobs, conditions, unevaluated });
  sentinelConditions({ sentinel, conditions, unevaluated });
  monitoringConditions({ persistence, conditions });
  httpConditions({ recent, conditions });
  return { conditions, unevaluated };
}
