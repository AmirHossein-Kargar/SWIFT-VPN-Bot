import axios from "axios";

const DEFAULT_BASE_URL = "https://hooshpay.xyz/api/v1";
const TIMEOUT_MS = 15_000;

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

  return axios.create({
    baseURL: baseURL.replace(/\/+$/, ""),
    timeout: TIMEOUT_MS,
    maxContentLength: 1_048_576,
    maxBodyLength: 1_048_576,
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
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
  try {
    const response = await client.request({ method, url: path, data });
    return response.data;
  } catch (error) {
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

export async function getInvoice(uid) {
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new TypeError("Invalid HooshPay invoice UID");
  return unwrap(await request("invoice lookup", "GET", `/invoices/${encodeURIComponent(uid)}`), "invoice lookup");
}

export async function cancelInvoice(uid) {
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new TypeError("Invalid HooshPay invoice UID");
  return unwrap(await request("invoice cancellation", "POST", `/invoices/${encodeURIComponent(uid)}/cancel`), "invoice cancellation");
}
