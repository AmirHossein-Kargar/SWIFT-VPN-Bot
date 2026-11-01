import axios from "axios";
import { observeProvider } from "../reliability/telemetry.js";

const DEFAULT_BASE_URL = "https://hooshpay.xyz/api/v1";
const TIMEOUT_MS = 15_000;
const clientCache = new Map();

export class HooshPayApiError extends Error {
  constructor(operation, { status, code, ambiguous = false } = {}) {
    const statusText = Number.isInteger(status) ? ` (HTTP ${status})` : "";
    super(`HooshPay ${operation} request failed${statusText}`);
    this.name = "HooshPayApiError";
    this.status = status;
    this.code = typeof code === "string" ? code : undefined;
    this.ambiguous = Boolean(ambiguous);
  }
}

export function createHooshPayClient({ apiKey = process.env.HOOSHPAY_API_KEY, baseURL = process.env.HOOSHPAY_API_BASE_URL || DEFAULT_BASE_URL } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("HOOSHPAY_API_KEY is not configured");
  let parsed;
  try { parsed = new URL(baseURL); } catch { throw new Error("HooshPay API base URL is invalid"); }
  const isLocalDevelopment = process.env.NODE_ENV !== "production" && parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if ((!isLocalDevelopment && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("HooshPay API base URL must be HTTPS without credentials, query, or fragment");
  }

  const normalizedBase = baseURL.replace(/\/+$/, "");
  const cacheKey = `${apiKey}\n${normalizedBase}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;
  const client = axios.create({
    baseURL: normalizedBase,
    timeout: TIMEOUT_MS,
    maxContentLength: 1_048_576,
    maxBodyLength: 1_048_576,
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  clientCache.set(cacheKey, client);
  if (clientCache.size > 4) clientCache.delete(clientCache.keys().next().value);
  return client;
}

function normalizeError(operation, error) {
  if (error instanceof HooshPayApiError) return error;
  const status = Number.isInteger(error?.response?.status) ? error.response.status : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const ambiguous = !status || status >= 500;
  return new HooshPayApiError(operation, { status, code, ambiguous });
}

async function request(operation, method, path, data) {
  const client = createHooshPayClient();
  const started = Date.now();
  try {
    const response = await client.request({ method, url: path, data });
    observeProvider("provider.hooshpay", { operation, ms: Date.now() - started });
    return response.data;
  } catch (error) {
    observeProvider("provider.hooshpay", { operation, ms: Date.now() - started, error });
    throw normalizeError(operation, error);
  }
}

function unwrap(body, operation) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.success !== true) {
    throw new HooshPayApiError(operation, {
      status: Number.isInteger(body?.status) ? body.status : undefined,
      code: "invalid_response",
      ambiguous: false,
    });
  }
  return body.data ?? body;
}

export async function createInvoice({ order_id, amount, callback_url, return_url, fee_mode = "buyer", description = "" }) {
  if (typeof order_id !== "string" || !order_id || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError("HooshPay order_id and positive integer amount are required");
  }
  if (!["seller", "buyer", "split"].includes(fee_mode)) throw new TypeError("Unsupported HooshPay fee mode");
  const payload = { order_id, amount, fee_mode, description: String(description).slice(0, 250) };
  if (callback_url) payload.callback_url = callback_url;
  if (return_url) payload.return_url = return_url;
  return unwrap(await request("invoice creation", "POST", "/invoices", payload), "invoice creation");
}

export async function verifyInvoice(uid) {
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new TypeError("Invalid HooshPay invoice UID");
  const body = await request("invoice verification", "POST", `/invoices/${encodeURIComponent(uid)}/verify`);
  if (!body || typeof body !== "object" || body.success !== true) {
    throw new HooshPayApiError("invoice verification", { code: "invalid_response", ambiguous: true });
  }
  const status = String(body.status ?? body.data?.status ?? "").toLowerCase();
  if (status && !["pending", "paid", "expired", "cancelled", "failed", "reversed", "refunded", "chargedback"].includes(status)) {
    throw new HooshPayApiError("invoice verification", { code: "invalid_status", ambiguous: true });
  }
  if (body.paid != null && typeof body.paid !== "boolean") {
    throw new HooshPayApiError("invoice verification", { code: "invalid_paid_flag", ambiguous: true });
  }
  return body;
}

/**
 * A health check, not traffic, so it stays out of the provider series: a green probe must not read as customers paying.
 *
 * `GET /api/v1/balance` is the documented read that needs the API key (`X-API-KEY`), so it proves reachability and the key together.
 * The reference gives its path and nothing else: no fields, no units, no example. Its one general promise is that responses carry
 * `success`, so that is all this relies on, and only the field NAMES are kept, never a value. Its status codes are documented: 401 a
 * missing or invalid key, 403 a blocked account, 503 the gateway switched off.
 */
export async function probeHooshPay() {
  const client = createHooshPayClient();
  try {
    const response = await client.get("/balance");
    const body = response.data;
    const fields = body && typeof body === "object" ? Object.keys(body).filter((name) => /^[A-Za-z0-9_]{1,40}$/.test(name)).sort().slice(0, 20) : [];
    return { reachable: true, authorized: true, recognized: body?.success === true, fields };
  } catch (error) {
    const status = Number.isInteger(error?.response?.status) ? error.response.status : null;
    if (status === 401) return { reachable: true, authorized: false, recognized: false };
    if (status === 403) return { reachable: true, authorized: true, blocked: true, recognized: false };
    if (status === 503) return { reachable: true, authorized: true, unavailable: true, recognized: false };
    // Any other 4xx is the service answering, so it is up, but not with anything documented for this path.
    if (status >= 400 && status < 500 && status !== 408) return { reachable: true, authorized: true, recognized: false };
    throw new HooshPayApiError("health check", { status: status ?? undefined, code: typeof error?.code === "string" ? error.code : undefined, ambiguous: true });
  }
}

export async function cancelInvoice(uid) {
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new TypeError("Invalid HooshPay invoice UID");
  return unwrap(await request("invoice cancellation", "POST", `/invoices/${encodeURIComponent(uid)}/cancel`), "invoice cancellation");
}
