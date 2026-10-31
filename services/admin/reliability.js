/**
 * Admin boundary of the Service Reliability Center: authorization and input validation over services/reliability.
 *
 * It is read-only: there is no mutation here, so no CSRF surface, no audit entry to write, and no way for the dashboard to
 * cancel an order, restart a job or touch a balance. Every parameter is validated to a scalar of a known shape, so a crafted
 * query string cannot become a MongoDB operator or an unbounded scan.
 */
import { AdminServiceError, assertAdminUser } from "./authorization.js";
import { filterDate, filterMatching, filterOneOf, parsePagination, requireTelegramId } from "./validation.js";
import { COMPONENT_IDS, WINDOWS } from "../reliability/constants.js";
import { getIncident, getOrderBacklog, getOrderTrace, listEvents, listIncidents, openStream, readHistory, readSnapshot } from "../reliability/queries.js";
import { StreamCapacityError } from "../reliability/stream.js";

const RANGES = Object.keys(WINDOWS);
const EVENT_SEVERITIES = ["critical", "error", "warning", "info"];
const EVENT_TYPES = ["webhook", "provider", "delivery", "dependency", "job", "incident", "polling", "order", "payment"];
const EVENT_TYPE = /^[a-z]{1,16}(\.[a-z_]{1,32})?$/;
const INCIDENT_ID = /^[0-9a-f-]{36}$/i;
const ORDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const INCIDENT_SEVERITIES = ["critical", "high", "medium", "low"];

function eventType(value) {
  const parsed = filterMatching(value, EVENT_TYPE, "invalid_event_type");
  if (parsed != null && !EVENT_TYPES.includes(parsed.split(".")[0])) throw new AdminServiceError("One of the filters is not valid.", { status: 400, code: "invalid_event_type" });
  return parsed;
}

export function getReliabilitySnapshot({ actorId } = {}) {
  assertAdminUser(actorId);
  return readSnapshot();
}

export function getReliabilityHistory({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  return readHistory({ range: filterOneOf(query.range, RANGES, "invalid_range", "1h") });
}

export async function getReliabilityEvents({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  const { pageSize } = parsePagination({ pageSize: query.limit ?? 50 });
  return listEvents({
    range: filterOneOf(query.range, RANGES, "invalid_range", "1h"),
    severity: filterOneOf(query.severity, EVENT_SEVERITIES, "invalid_severity"),
    component: filterOneOf(query.component, COMPONENT_IDS, "invalid_component"),
    type: eventType(query.type),
    before: filterDate(query.before, "invalid_cursor"),
    limit: pageSize,
  });
}

export async function getReliabilityIncidents({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  const { page, pageSize } = parsePagination(query);
  return listIncidents({
    state: filterOneOf(query.state, ["open", "resolved", "all"], "invalid_state", "open"),
    severity: filterOneOf(query.severity, INCIDENT_SEVERITIES, "invalid_severity"),
    component: filterOneOf(query.component, COMPONENT_IDS, "invalid_component"),
    page,
    limit: pageSize,
  });
}

export async function getReliabilityIncident({ actorId, id } = {}) {
  assertAdminUser(actorId);
  if (typeof id !== "string" || !INCIDENT_ID.test(id)) throw new AdminServiceError("Incident not found.", { status: 400, code: "invalid_incident_id" });
  const incident = await getIncident({ id });
  if (!incident) throw new AdminServiceError("Incident not found.", { status: 404, code: "incident_not_found" });
  return incident;
}

export async function getReliabilityOrders({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  const userId = filterMatching(query.userId, /^.{1,24}$/, "invalid_user_id");
  return getOrderBacklog({ userId: userId == null ? null : requireTelegramId(userId) });
}

export async function getReliabilityOrderTrace({ actorId, orderId } = {}) {
  assertAdminUser(actorId);
  const id = typeof orderId === "string" ? orderId.replace(/^wallet:/, "") : "";
  if (!ORDER_ID.test(id)) throw new AdminServiceError("Order not found.", { status: 400, code: "invalid_order_id" });
  const trace = await getOrderTrace({ orderId: id });
  if (!trace) throw new AdminServiceError("Order not found.", { status: 404, code: "order_not_found" });
  return trace;
}

export function openReliabilityStream({ actorId, token, lastEventId, req, res } = {}) {
  assertAdminUser(actorId);
  const cursor = typeof lastEventId === "string" && /^[a-f0-9]{1,16}:\d{1,12}$/.test(lastEventId) ? lastEventId : null;
  try {
    openStream({ req, res, actorId: String(actorId), token, lastEventId: cursor });
  } catch (error) {
    if (error instanceof StreamCapacityError) throw new AdminServiceError("Too many live connections are open. Close another panel tab.", { status: 503, code: "stream_capacity" });
    throw error;
  }
}
