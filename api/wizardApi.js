import axios from "axios";

/**
 * WizardXray web service v1 (see the provider document "API v1"):
 *   base   https://robot.wizardxray.shop/newbot/api/v1/<method>   (WIZARD_API_URL)
 *   header Authorization: Bearer <api key>                        (VPN_API_KEY)
 *   output JSON { ok, error, result, http_code }; success = ok:true / http_code 200
 * Methods: status(GET) clients(GET, limit) create find delsv change_link
 *          upg_time upg_size reverse_mode (POST, form encoded).
 */
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576;
let cachedClient = null;
let cachedClientKey = "";

export class WizardApiError extends Error {
  constructor(operation, { status, code, ambiguous = false } = {}) {
    super(`Wizard panel ${operation} failed${Number.isInteger(status) ? ` (HTTP ${status})` : ""}`);
    this.name = "WizardApiError";
    this.status = status;
    this.code = typeof code === "string" ? code : undefined;
    this.ambiguous = Boolean(ambiguous);
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
    timeout: TIMEOUT_MS,
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

function safeError(operation, error, { mutation = false } = {}) {
  const status = Number.isInteger(error?.response?.status) ? error.response.status : undefined;
  const code = status === 402
    ? "provider_insufficient_balance"
    : (typeof error?.code === "string" ? error.code : undefined);
  return new WizardApiError(operation, {
    status,
    code,
    ambiguous: mutation && (!status || status >= 500),
  });
}

// Keep only a coarse, non-sensitive rejection category. Never persist or log
// the raw provider response because it may contain supplier pricing details.
function panelRejectionCode(body, status) {
  if (status === 402) return "provider_insufficient_balance";
  const details = [body?.code, body?.error, body?.message]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (/insufficient(?:\s+provider)?\s+balance|not enough(?:\s+provider)?\s+balance|balance.{0,24}insufficient/i.test(details)) {
    return "provider_insufficient_balance";
  }
  return "panel_rejected_request";
}

async function request(operation, method, path, form, { mutation = false } = {}) {
  const client = getClient();
  try {
    const response = await client.request({
      method,
      url: path,
      data: form ? form.toString() : undefined,
    });
    const body = response.data;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new WizardApiError(operation, {
        status: response.status,
        code: "invalid_response",
        ambiguous: mutation,
      });
    }
    if (body.ok !== true) {
      throw new WizardApiError(operation, {
        status: response.status,
        code: panelRejectionCode(body, response.status),
        ambiguous: false,
      });
    }
    return body;
  } catch (error) {
    if (error instanceof WizardApiError) throw error;
    throw safeError(operation, error, { mutation });
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

function validatedProvisioningResponse(data, operation) {
  const result = data?.result;
  const validHash = typeof result?.hash === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(result.hash);
  const validSubLink = typeof result?.sub_link === "string" && result.sub_link.length <= 4096 && /^https:\/\//i.test(result.sub_link);
  try { requireUsername(result?.username); } catch {
    throw new WizardApiError(operation, { code: "invalid_provisioning_response", ambiguous: true });
  }
  if (!validHash && !validSubLink) {
    throw new WizardApiError(operation, { code: "invalid_provisioning_response", ambiguous: true });
  }
  return data;
}

const MIN_GIG = 0.5;
function requireGig(value, name = "gig") {
  const gig = Number(value);
  if (!Number.isFinite(gig) || gig < MIN_GIG || gig > 100_000 || Math.round(gig * 100) / 100 !== gig) {
    throw new TypeError(`${name} must be a number of at least ${MIN_GIG} (max two decimals)`);
  }
  return gig;
}
function requireDays(value, name = "day") {
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new TypeError(`${name} must be a positive integer number of days`);
  return days;
}

export async function createVpnService(gig, day, test = 0) {
  gig = requireGig(gig);
  day = requireDays(day);
  if (![0, 1].includes(Number(test))) throw new TypeError("test must be 0 or 1");
  const data = await request("service creation", "POST", "/create", form({ gig, day, test }), { mutation: true });
  return validatedProvisioningResponse(data, "service creation");
}

export async function findService(username) {
  requireUsername(username);
  return request("service lookup", "POST", "/find", form({ username }));
}

export async function createTestService() {
  const data = await request("test service creation", "POST", "/create", form({ test: 1 }), { mutation: true });
  return validatedProvisioningResponse(data, "test service creation");
}

export async function changeLinkService(username) {
  requireUsername(username);
  return request("link change", "POST", "/change_link", form({ username }), { mutation: true });
}

export async function deleteService(username) {
  requireUsername(username);
  return request("service deletion", "POST", "/delsv", form({ username }), { mutation: true });
}

export async function deactiveService(username) {
  requireUsername(username);
  return request("service mode change", "POST", "/reverse_mode", form({ username }), { mutation: true });
}

/** Documented `clients` (GET, optional limit): services created through this key. */
export async function listClients(limit) {
  let path = "/clients";
  if (limit !== undefined && limit !== null && limit !== "") {
    const value = Number(limit);
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new TypeError("limit must be a positive integer");
    path += `?limit=${value}`;
  }
  const data = await request("clients lookup", "GET", path);
  if (data.result != null && !Array.isArray(data.result) && typeof data.result !== "object") {
    throw new WizardApiError("clients lookup", { code: "invalid_response" });
  }
  return data;
}

/** Documented `upg_time`: add `day` days (min 1) to an existing service. Mutation: never auto-retried. */
export async function upgradeServiceTime(username, day) {
  requireUsername(username);
  return request("service time upgrade", "POST", "/upg_time", form({ username, day: requireDays(day) }), { mutation: true });
}

/** Documented `upg_size`: add `gig` GB (min 0.5) to an existing service. Mutation: never auto-retried. */
export async function upgradeServiceSize(username, gig) {
  requireUsername(username);
  return request("service size upgrade", "POST", "/upg_size", form({ username, gig: requireGig(gig) }), { mutation: true });
}

export async function StatusApi() {
  const data = await request("status lookup", "GET", "/status");
  const perGb = Number(data.result?.per_gb);
  const perDay = Number(data.result?.per_day);
  if (!Number.isFinite(perGb) || perGb < 0 || !Number.isFinite(perDay) || perDay < 0) {
    throw new WizardApiError("status lookup", { code: "invalid_price_response" });
  }
  return data;
}
