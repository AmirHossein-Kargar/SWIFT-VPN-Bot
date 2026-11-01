import axios from "axios";
import { observeProvider, observeProviderStart } from "../services/reliability/telemetry.js";
import { BUSY, OPERATION_FAILED, REJECTED, SHORT_OF_FUNDS, findDocumentedError } from "./wizardErrors.js";

/**
 * WizardXray web service v1. docs/wizardxray.md maps every documented method, alias and error to this file and its callers.
 *
 *   base    WIZARD_API_URL, always ending in /api/v1/ (each bot account has its own address)
 *   header  Authorization: Bearer <api key>   (VPN_API_KEY)
 *   output  JSON { ok, error, result, http_code }, and the HTTP status always equals http_code
 *
 * Rules this file exists to hold:
 *  - A mutation is sent once and never retried here: `create` has no idempotency key.
 *  - "Nothing happened" needs proof: an explicit, self-consistent refusal. Everything else is ambiguous.
 *  - `gig = 0` means unlimited, and only a literal numeric zero can say so. Blank, null or false never becomes unlimited.
 *  - Provider text never leaves this file. Callers get stable codes, and the supplier's prices stay out of logs and records.
 */
const READ_TIMEOUT_MS = 15_000;
/** The document: create and renew make several calls to the service panel, so a client should wait at least 60 seconds. */
const MUTATION_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 1_048_576;

export const GIB = 1_073_741_824;
export const UNLIMITED_GIG = 0;
export const SERVICE_STATUSES = Object.freeze(["active", "disabled", "limited", "expired", "on_hold"]);

const MIN_GIG = 0.5;
const MIN_ADD_GIG = 1;
const MAX_GIG = 10_000;
const MAX_DAYS = 3650;

let timeouts = { read: READ_TIMEOUT_MS, mutation: MUTATION_TIMEOUT_MS };
let cachedClient = null;
let cachedClientKey = "";

/** Test seam: a hanging request would otherwise hold a test for the full minute. */
export function setWizardTimeoutsForTests(values) {
  timeouts = values ? { ...timeouts, ...values } : { read: READ_TIMEOUT_MS, mutation: MUTATION_TIMEOUT_MS };
}

export class WizardApiError extends Error {
  constructor(operation, { status, code, ambiguous = false, reason = null, retry = false, outage = false } = {}) {
    super(`Wizard panel ${operation} failed${Number.isInteger(status) ? ` (HTTP ${status})` : ""}`);
    this.name = "WizardApiError";
    this.status = status;
    this.code = typeof code === "string" ? code : undefined;
    this.ambiguous = Boolean(ambiguous);
    /** The specific documented cause (wizardErrors.js), or null. */
    this.reason = reason;
    /** The same request can be sent again as it is: nothing was charged or changed. */
    this.retry = Boolean(retry);
    /** The panel failed, as opposed to refusing this request. */
    this.outage = Boolean(outage);
  }
}

function getClient() {
  const baseURL = process.env.WIZARD_API_URL?.trim();
  const apiKey = process.env.VPN_API_KEY;
  if (!baseURL) throw new Error("WIZARD_API_URL is not configured");
  if (!apiKey) throw new Error("VPN_API_KEY is not configured");

  let parsed;
  try { parsed = new URL(baseURL); } catch { throw new Error("WIZARD_API_URL is invalid"); }
  const localDevelopment = process.env.NODE_ENV !== "production" && parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if ((!localDevelopment && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("WIZARD_API_URL must be HTTPS and must not contain credentials, a query, or a fragment");
  }

  const normalizedBase = baseURL.replace(/\/+$/, "");
  const cacheKey = `${apiKey}\n${normalizedBase}`;
  if (cachedClient && cachedClientKey === cacheKey) return cachedClient;
  cachedClientKey = cacheKey;
  cachedClient = axios.create({
    baseURL: normalizedBase,
    // Never follow redirects: axios would turn a redirected POST into a GET (301/302/303) or re-send the mutation to
    // another URL (307/308), and report whatever that other endpoint answered as the provider's answer.
    maxRedirects: 0,
    maxContentLength: MAX_BODY_BYTES,
    maxBodyLength: MAX_BODY_BYTES,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  return cachedClient;
}

/**
 * Codes carried ONLY by errors the client has proven to mean "this request did not take effect", so callers that must decide
 * retryable-or-not rely on these instead of re-deriving a verdict from a bare HTTP status.
 */
export const WIZARD_REJECTION_CODES = Object.freeze([SHORT_OF_FUNDS, REJECTED, BUSY, OPERATION_FAILED]);

const isClientErrorStatus = (status) => Number.isInteger(status) && status >= 400 && status < 500 && status !== 408;

/** The panel's own status field: undefined when absent, NaN when present but malformed. */
function bodyHttpCode(body) {
  const raw = body.http_code;
  if (raw === undefined || raw === null) return undefined;
  const parsed = typeof raw === "number" ? raw : (typeof raw === "string" && /^\d{3}$/.test(raw) ? Number(raw) : Number.NaN);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

/**
 * Evidence that the panel REFUSED a request, as opposed to failing, being cut off or answering something else. Accepted only
 * when the body is a JSON object whose `ok` is exactly false, the transport status is 2xx or a 4xx other than 408, and the
 * body's `http_code`, if present, is a well-formed 4xx other than 408. Anything else is not established as a refusal.
 */
function isExplicitRejection(body, httpStatus) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.ok !== false) return false;
  const transportOk = (httpStatus >= 200 && httpStatus < 300) || isClientErrorStatus(httpStatus);
  if (!transportOk) return false;
  const reported = bodyHttpCode(body);
  return reported === undefined || isClientErrorStatus(reported);
}

/** Older panels worded a shortage differently and used transport 200. Text only, because a body may carry supplier prices. */
function legacyShortOfFunds(body) {
  const details = [body?.code, body?.error, body?.message].filter((value) => typeof value === "string").join(" ");
  return /insufficient(?:\s+provider)?\s+balance|not enough(?:\s+provider)?\s+balance|balance.{0,24}insufficient/i.test(details);
}

function methodOf(path) {
  return String(path).replace(/^\//, "").split("?")[0];
}

/** The verdict for a proven refusal. The body's http_code wins, since transport 200 refusals exist in older panels. */
function refusalFields(body, status, path) {
  const reported = bodyHttpCode(body);
  const httpCode = Number.isInteger(reported) ? reported : status;
  const documented = findDocumentedError(methodOf(path), httpCode, body?.error);
  if (documented) return { code: documented.code, reason: documented.reason, retry: documented.retry, outage: documented.outage };
  if (httpCode === 402 || legacyShortOfFunds(body)) return { code: SHORT_OF_FUNDS, reason: SHORT_OF_FUNDS };
  return { code: REJECTED, reason: null };
}

/**
 * The one exception to "a 5xx proves nothing": a server-side failure the document lists word for word, for this method, on a
 * self-consistent 500. For those it states the outcome ("the amount was returned"). Anything else on a 5xx, including the
 * documented `internal error`, stays ambiguous because nobody promises what happened.
 */
function documentedServerFailure(body, status, path) {
  if (status !== 500 || !body || typeof body !== "object" || body.ok !== false || bodyHttpCode(body) !== 500) return null;
  const documented = findDocumentedError(methodOf(path), 500, body.error);
  return documented ? { code: documented.code, reason: documented.reason, retry: documented.retry, outage: documented.outage } : null;
}

function safeError(operation, error, path, { mutation = false } = {}) {
  const status = Number.isInteger(error?.response?.status) ? error.response.status : undefined;
  const body = error?.response?.data;
  if (isClientErrorStatus(status) && isExplicitRejection(body, status)) {
    return new WizardApiError(operation, { status, ...refusalFields(body, status, path), ambiguous: false });
  }
  const serverFailure = documentedServerFailure(body, status, path);
  if (serverFailure) return new WizardApiError(operation, { status, ...serverFailure, ambiguous: false });
  // Only a mutation that is PROVEN refused may be treated as "nothing happened". A bare status never proves it: a 2xx whose
  // body was cut off, a 3xx, a 408, a 5xx and any error without a response all stay ambiguous.
  const code = !mutation && status === 402 ? SHORT_OF_FUNDS : (typeof error?.code === "string" ? error.code : undefined);
  return new WizardApiError(operation, { status, code, ambiguous: mutation, outage: true });
}

/** Telemetry only: the call, its result and its error reach the caller exactly as sendRequest produced them. */
async function request(operation, method, path, requestForm, options = {}) {
  const series = /creation/.test(operation) ? "provider.wizardxray.create" : options.mutation ? "provider.wizardxray.write" : "provider.wizardxray.read";
  const creating = series === "provider.wizardxray.create";
  const started = Date.now();
  if (creating) observeProviderStart(series, { operation });
  try {
    const body = await sendRequest(operation, method, path, requestForm, options);
    observeProvider(series, { operation, ms: Date.now() - started, mutation: creating });
    return body;
  } catch (error) {
    // A proven refusal is the panel answering, not the panel being down. An expected empty answer is not a failure at all.
    const expected = options.expected?.includes(error?.reason);
    if (expected) observeProvider(series, { operation, ms: Date.now() - started, mutation: creating });
    else observeProvider(series, { operation, ms: Date.now() - started, error, rejected: WIZARD_REJECTION_CODES.includes(error?.code) && !error.outage, mutation: creating });
    throw error;
  }
}

async function sendRequest(operation, method, path, form, { mutation = false } = {}) {
  const client = getClient();
  try {
    const response = await client.request({
      method,
      url: path,
      data: form ? form.toString() : undefined,
      timeout: mutation ? timeouts.mutation : timeouts.read,
    });
    const body = response.data;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new WizardApiError(operation, { status: response.status, code: "invalid_response", ambiguous: mutation });
    }
    if (body.ok !== true) {
      const refused = isExplicitRejection(body, response.status);
      if (mutation && !refused) {
        // ok is not literally false, or the body contradicts a refusal (e.g. a server-side http_code): unknown outcome.
        throw new WizardApiError(operation, { status: response.status, code: "panel_response_unproven", ambiguous: true });
      }
      throw new WizardApiError(operation, { status: response.status, ...refusalFields(body, response.status, path), ambiguous: false });
    }
    return body;
  } catch (error) {
    if (error instanceof WizardApiError) throw error;
    throw safeError(operation, error, path, { mutation });
  }
}

function form(fields) {
  const data = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) data.set(key, String(value));
  }
  return data;
}

function requireUsername(username) {
  if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(username)) {
    throw new TypeError("A valid VPN service username is required");
  }
}

/** Number("") is 0 and Number(null) is 0, and here 0 is a product. So a quantity must look like one before it is converted. */
function quantity(value) {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : Number.NaN;
}

function requireGig(value, { name = "gig", min = MIN_GIG, unlimited = false } = {}) {
  if (unlimited && value === UNLIMITED_GIG) return UNLIMITED_GIG;
  const gig = quantity(value);
  if (!Number.isFinite(gig) || gig < min || gig > MAX_GIG || Math.round(gig * 100) / 100 !== gig) {
    throw new TypeError(`${name} must be a number of at least ${min} and at most ${MAX_GIG} (max two decimals)`);
  }
  return gig;
}

function requireDays(value, name = "day") {
  const days = quantity(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) throw new TypeError(`${name} must be a positive integer number of days`);
  return days;
}

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);

function validHttpsLink(value) {
  return typeof value === "string" && value.length <= 4096 && /^https:\/\//i.test(value) ? value : null;
}

/**
 * The service object (section 4 of the document) as this application uses it. Every method that returns one goes through here,
 * whether it arrived in `result` or `result.service`.
 *
 * Traffic is the trap. `data_limit: 0` and `remaining_traffic: null` mean unlimited, not empty, so `remainingBytes` is null and
 * `remainingGb` is null for an unlimited service and nothing may treat either as zero. Unlimited traffic is not unlimited time:
 * `expire` still applies, and only `expire: 0` means no date.
 *
 * `live` is false for `source: "cache"`, the bot's last stored copy, where usage is old and `links` is empty.
 */
export function normalizeService(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.username !== "string" || !raw.username.trim()) return null;
  const dataLimit = finite(raw.data_limit);
  const unlimited = raw.unlimited === true || (raw.unlimited === undefined && dataLimit === 0);
  const seconds = finite(raw.expire);
  const status = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : null;
  return {
    username: raw.username,
    status,
    source: raw.source === "panel" || raw.source === "cache" ? raw.source : null,
    live: raw.source === "panel",
    test: raw.test === true,
    unlimited,
    subLink: validHttpsLink(raw.sub_link),
    links: Array.isArray(raw.links) ? raw.links.filter((link) => typeof link === "string" && link.length <= 4096) : [],
    expiresAt: seconds && seconds > 0 ? new Date(seconds * 1000) : null,
    expireJalali: typeof raw.expire_jalali === "string" ? raw.expire_jalali.slice(0, 40) : null,
    daysLeft: finite(raw.days_left),
    dataLimitBytes: unlimited ? 0 : dataLimit,
    usedBytes: finite(raw.used_traffic),
    remainingBytes: unlimited ? null : finite(raw.remaining_traffic),
    dataLimitGb: unlimited ? 0 : finite(raw.data_limit_gb),
    usedGb: finite(raw.used_traffic_gb),
    remainingGb: unlimited ? null : finite(raw.remaining_traffic_gb),
    onlineAt: finite(raw.online_at),
    lastClient: typeof raw.last_client === "string" ? raw.last_client.slice(0, 120) : null,
    createdAt: finite(raw.created_at),
  };
}

const withService = (data) => ({ ...data, service: normalizeService(data?.result?.service) });

/**
 * A response that claims success is checked against what was asked for. A service that came back with other terms exists and
 * was charged, so it is neither a success nor a failure: ambiguous, and an admin decides.
 */
function validatedProvisioningResponse(data, operation, { gig = null, day = null } = {}) {
  const result = data?.result;
  const validHash = typeof result?.hash === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(result.hash);
  const validSubLink = typeof result?.sub_link === "string" && result.sub_link.length <= 4096 && /^https:\/\//i.test(result.sub_link);
  try { requireUsername(result?.username); } catch {
    throw new WizardApiError(operation, { code: "invalid_provisioning_response", ambiguous: true });
  }
  if (!validHash && !validSubLink) {
    throw new WizardApiError(operation, { code: "invalid_provisioning_response", ambiguous: true });
  }
  const service = normalizeService(result.service);
  const gotUnlimited = result.unlimited === true || service?.unlimited === true;
  const echoedGig = finite(result.gig);
  const echoedDay = finite(result.day);
  const wrongTerms = gig !== null && (
    (gig === UNLIMITED_GIG) !== gotUnlimited && (result.unlimited !== undefined || service != null)
    || (echoedGig !== null && echoedGig !== gig)
    || (day !== null && echoedDay !== null && echoedDay !== day)
  );
  if (wrongTerms) throw new WizardApiError(operation, { code: "provisioning_terms_mismatch", ambiguous: true });
  return withService(data);
}

/** `gig` may be UNLIMITED_GIG. Whether the account sells unlimited is `getAccount().limits.unlimitedEnabled`. */
export async function createVpnService(gig, day, test = 0) {
  gig = requireGig(gig, { unlimited: true });
  day = requireDays(day);
  if (![0, 1].includes(Number(test))) throw new TypeError("test must be 0 or 1");
  const data = await request("service creation", "POST", "/create", form({ test, gig, day }), { mutation: true });
  return validatedProvisioningResponse(data, "service creation", { gig, day });
}

export async function createTestService() {
  const data = await request("test service creation", "POST", "/create", form({ test: 1 }), { mutation: true });
  return validatedProvisioningResponse(data, "test service creation");
}

/** `info`: the live service object, or the bot's stored copy with `live: false` while the service panel is unreachable. */
export async function getServiceInfo(username) {
  requireUsername(username);
  const data = await request("service lookup", "GET", `/info?${form({ username })}`);
  const service = normalizeService(data.result);
  if (!service) throw new WizardApiError("service lookup", { code: "invalid_response" });
  return service;
}

export async function changeLinkService(username) {
  requireUsername(username);
  const data = await request("link change", "POST", "/change_link", form({ username }), { mutation: true });
  const out = withService(data);
  // The old link is already dead here, so a response without a usable new one must not be mistaken for a clean success.
  if (!validHttpsLink(data.result?.new_sub_link)) throw new WizardApiError("link change", { code: "invalid_response", ambiguous: true });
  return out;
}

/**
 * `delsv`. Deleting twice, or deleting what does not exist, answers `ok` without `return_price`, which `alreadyGone` reports.
 * The provider refunds its own wallet, not the customer's: `returnPrice` is what it credited, for the record only.
 */
export async function deleteService(username) {
  requireUsername(username);
  const data = await request("service deletion", "POST", "/delsv", form({ username }), { mutation: true });
  const returnPrice = finite(data.return_price);
  return { ...data, returnPrice, alreadyGone: returnPrice === null };
}

/**
 * `reverse_mode` with `status`. Sending it without one toggles, so a repeated request silently undoes itself; the document
 * recommends always naming the state and this client offers nothing else.
 */
export async function setServiceStatus(username, status) {
  requireUsername(username);
  if (status !== "active" && status !== "disabled") throw new TypeError("status must be active or disabled");
  const data = await request("service status change", "POST", "/reverse_mode", form({ username, status }), { mutation: true });
  const newMode = data.result?.new_mode;
  if (newMode !== status) throw new WizardApiError("service status change", { code: "invalid_response", ambiguous: true });
  return withService(data);
}

/**
 * One page of `clients`, from the bot's stored copy, nearest expiry first: never live usage (`info` is). The panel answers
 * 404 `no service` for an empty account and for an offset past the end, which is an empty page, not a failure.
 */
export async function listClients({ limit, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (limit !== undefined && limit !== null && limit !== "") {
    const value = Number(limit);
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new TypeError("limit must be a positive integer");
    params.set("limit", String(value));
  }
  const start = Number(offset);
  if (!Number.isSafeInteger(start) || start < 0) throw new TypeError("offset must be zero or a positive integer");
  if (start > 0) params.set("offset", String(start));
  const query = params.toString();
  let data;
  try {
    data = await request("clients lookup", "GET", `/clients${query ? `?${query}` : ""}`, undefined, { expected: ["no_services"] });
  } catch (error) {
    if (error?.reason === "no_services") return { count: 0, total: start > 0 ? null : 0, items: [] };
    throw error;
  }
  const list = data.result?.list;
  if (!Array.isArray(list)) throw new WizardApiError("clients lookup", { code: "invalid_response" });
  return { count: finite(data.result.count) ?? list.length, total: finite(data.result.total), items: list };
}

/** Documented `upg_time`: add days. For an unlimited service the price is per unlimited day. Mutation: never retried. */
export async function upgradeServiceTime(username, day) {
  requireUsername(username);
  return withService(await request("service time upgrade", "POST", "/upg_time", form({ username, day: requireDays(day) }), { mutation: true }));
}

/** Documented `upg_size`: add gigabytes (min 1). An unlimited service refuses it. Mutation: never retried. */
export async function upgradeServiceSize(username, gig) {
  requireUsername(username);
  const added = requireGig(gig, { min: MIN_ADD_GIG });
  return withService(await request("service size upgrade", "POST", "/upg_size", form({ username, gig: added }), { mutation: true }));
}

/**
 * Documented `renew`: usage resets, `day` days are added, `gig` is the new volume and UNLIMITED_GIG renews as unlimited. What
 * carries over depends on the conversion, and volume to unlimited forfeits the rest of the old period. See docs/wizardxray.md.
 */
export async function renewService(username, gig, day) {
  requireUsername(username);
  const terms = { username, gig: requireGig(gig, { unlimited: true }), day: requireDays(day) };
  return withService(await request("service renewal", "POST", "/renew", form(terms), { mutation: true }));
}

/** `price`: the provider's cost of these terms for this account, with no purchase. */
export async function quotePrice(gig, day) {
  const terms = { gig: requireGig(gig, { unlimited: true }), day: requireDays(day) };
  const data = await request("price quote", "GET", `/price?${form(terms)}`);
  const price = finite(data.result?.price);
  if (price === null || price < 0) throw new WizardApiError("price quote", { code: "invalid_price_response" });
  return { gig: terms.gig, day: terms.day, unlimited: data.result.unlimited === true, price, balance: finite(data.result.balance), enough: data.result.enough === true };
}

/**
 * `me`: balance, this account's prices and its limits. Every field differs per account, so nothing here may be assumed from the
 * document's example. Unlimited is on only when both the flag says so and it has a price: `unlimited_per_day: 0` means off.
 */
export async function getAccount() {
  const data = await request("account lookup", "GET", "/me");
  const { balance, prices, limits, services } = data.result ?? {};
  const perGb = finite(prices?.per_gb);
  const perDay = finite(prices?.per_day);
  if (perGb === null || perGb < 0 || perDay === null || perDay < 0 || !limits || typeof limits !== "object") {
    throw new WizardApiError("account lookup", { code: "invalid_price_response" });
  }
  const unlimitedPerDay = finite(prices.unlimited_per_day) ?? 0;
  return {
    balance: finite(balance),
    currency: typeof data.result.currency === "string" ? data.result.currency.slice(0, 16) : null,
    prices: { perGb, perDay, unlimitedPerDay, test: finite(prices.test), custom: prices.custom === true },
    limits: {
      minGig: finite(limits.min_gig) ?? MIN_GIG,
      maxGig: finite(limits.max_gig) ?? MAX_GIG,
      minDay: finite(limits.min_day) ?? 1,
      maxDay: finite(limits.max_day) ?? MAX_DAYS,
      minAddGig: finite(limits.min_add_gig) ?? MIN_ADD_GIG,
      minAddDay: finite(limits.min_add_day) ?? 1,
      unlimitedEnabled: limits.unlimited_enabled === true && unlimitedPerDay > 0,
      testEnabled: limits.test_enabled === true,
      testGig: finite(limits.test_gig),
      testDay: finite(limits.test_day),
      maxTests: finite(limits.max_tests),
      testsUsed: finite(limits.tests_used),
    },
    services: { total: finite(services?.total), active: finite(services?.active) },
  };
}

/**
 * `get_hosts`: the locations in every subscription link, by inbound. The panel answers 403 with an empty `error` when none are
 * defined or the service panel did not answer. Node addresses and ports stay here: nothing in this application needs them.
 */
export async function getHosts() {
  const data = await request("location lookup", "GET", "/get_hosts");
  const groups = data.result;
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) throw new WizardApiError("location lookup", { code: "invalid_response" });
  const hosts = [];
  for (const [inbound, rows] of Object.entries(groups)) {
    if (!Array.isArray(rows)) continue;
    for (const host of rows) {
      if (host && typeof host === "object") hosts.push({ inbound: String(inbound).slice(0, 60), remark: typeof host.remark === "string" ? host.remark.slice(0, 80) : null, disabled: host.is_disabled === true });
    }
  }
  return hosts;
}

/** Legacy `status`. `ping` is in seconds in this method, and `system` says whether the bot still reaches the service panel. */
export async function StatusApi() {
  const data = await request("status lookup", "GET", "/status");
  const perGb = Number(data.result?.per_gb);
  const perDay = Number(data.result?.per_day);
  if (!Number.isFinite(perGb) || perGb < 0 || !Number.isFinite(perDay) || perDay < 0) {
    throw new WizardApiError("status lookup", { code: "invalid_price_response" });
  }
  return data;
}

/** The legacy `ping` field, in the milliseconds everything else here uses. */
export function panelPingMs(result) {
  const seconds = finite(result?.ping);
  return seconds === null || seconds < 0 ? null : Math.round(seconds * 1000);
}
