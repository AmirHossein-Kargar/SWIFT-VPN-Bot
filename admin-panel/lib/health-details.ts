import type { SystemHealthService } from "@/lib/types";

/** Which server-sanitized health details the cards show. Pure so it can be unit-tested without React. */
export type DetailRow = { label: string; value: string; warn?: boolean };

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Only server-sanitized fields are shown (counts and flags); nothing here comes from user input. */
export function detailRows(service: SystemHealthService): DetailRow[] {
  const details = asRecord(service.details);
  if (service.name === "orders") {
    const counts: Array<[string, string, boolean]> = [
      ["awaitingProvider", "Waiting for provider funds", true],
      ["needsReview", "Need manual reconciliation", true],
      ["stalledProvisioning", "Stuck in provisioning", true],
      ["ledgerStalled", "Interrupted ledger step", true],
      ["refundPending", "Refunds pending", true],
      ["alertPending", "…of which admin alert not delivered", true],
      ["deliveryPending", "Created, not delivered", true],
    ];
    const rows = counts.flatMap(([key, label, warnable]): DetailRow[] => {
      const value = asNumber(details[key]);
      return value === null ? [] : [{ label, value: String(value), warn: warnable && value > 0 }];
    });
    const oldest = asNumber(details.oldestAwaitingMinutes);
    if (oldest !== null) rows.push({ label: "Oldest waiting", value: `${oldest} min`, warn: oldest > 60 });
    return rows;
  }
  if (service.name === "wizardxray") {
    const rows: DetailRow[] = [];
    const ping = asNumber(details.panelPingMs);
    if (ping !== null) rows.push({ label: "Service panel ping", value: `${ping} ms` });
    const balance = asNumber(details.balanceToman);
    if (balance !== null) rows.push({ label: "Provider balance", value: `${balance.toLocaleString("en-US")} Toman` });
    const locations = asNumber(details.locations);
    if (locations !== null) rows.push({ label: "Locations", value: String(locations), warn: locations === 0 });
    if (typeof details.unlimitedEnabled === "boolean") rows.push({ label: "Unlimited", value: details.unlimitedEnabled ? "on" : "off" });
    return rows;
  }
  if (service.name === "background-jobs") {
    const jobs = Array.isArray(details.jobs) ? details.jobs : [];
    return jobs.map(asRecord).filter((job) => typeof job.label === "string").map((job) => ({ label: String(job.label), value: String(job.state ?? "unknown"), warn: job.state === "failed" || job.state === "degraded" }));
  }
  if (service.name === "telegram") {
    const rows: DetailRow[] = [];
    const polling = asRecord(details.polling);
    if (typeof polling.failing === "boolean") {
      const stalled = polling.stalled === true;
      const value = polling.failing ? "failing" : stalled ? "stalled" : "ok";
      rows.push({ label: "Long polling", value, warn: polling.failing || stalled });
      const success = asNumber(polling.lastSuccessAgeSec);
      if (success !== null) rows.push({ label: "Last successful poll", value: `${success} s ago`, warn: stalled });
    }
    const webhook = asRecord(details.webhook);
    if (webhook.available === false) {
      rows.push({ label: "Webhook info", value: "unavailable" });
    } else {
      if (typeof webhook.registered === "boolean") rows.push({ label: "Webhook registered", value: webhook.registered ? "yes" : "no", warn: webhook.registered });
      const pending = asNumber(webhook.pendingUpdates);
      if (pending !== null) rows.push({ label: "Updates waiting at Telegram", value: String(pending), warn: pending > 100 });
    }
    return rows;
  }
  return [];
}
