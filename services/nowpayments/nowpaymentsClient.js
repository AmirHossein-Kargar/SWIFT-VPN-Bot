import axios from "axios";
import { NowPaymentsFlowError } from "./money.js";

export class NowPaymentsApiError extends Error {
  constructor(code, { status, ambiguous = false } = {}) {
    super(`NOWPayments request failed${Number.isInteger(status) ? ` (HTTP ${status})` : ""}`);
    this.name = "NowPaymentsApiError";
    this.code = code;
    this.status = status;
    this.ambiguous = Boolean(ambiguous);
  }
}

function providerDetails(data) {
  if (!data || typeof data !== "object") return {};
  const code = data.code ?? data.error;
  const message = typeof data.message === "string" ? data.message : undefined;
  return {
    providerCode: code == null ? undefined : String(code).slice(0, 80),
    providerMessage: message ? String(message).slice(0, 180) : undefined,
  };
}

export function createNowPaymentsRequest({ apiKey, baseURL, transport = axios.request } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new NowPaymentsFlowError("not_configured");
  return async function nowpaymentsRequest({ method, path, data }) {
    const headers = {
      "x-api-key": apiKey,
      Accept: "application/json",
    };
    // GET /v1/estimate is documented with x-api-key only. A JSON body is not part of that contract.
    if (data !== undefined) headers["Content-Type"] = "application/json";
    try {
      const response = await transport({
        method,
        url: `${baseURL}${path}`,
        data,
        headers,
        timeout: 15_000,
        maxContentLength: 1_048_576,
        maxBodyLength: 1_048_576,
        validateStatus: () => true,
      });
      return { status: response.status, data: response.data, ...providerDetails(response.data) };
    } catch (error) {
      const status = Number.isInteger(error?.response?.status) ? error.response.status : undefined;
      const details = providerDetails(error?.response?.data);
      const wrapped = new NowPaymentsApiError("transport", { status, ambiguous: !status || status >= 500 });
      wrapped.providerCode = details.providerCode;
      wrapped.providerMessage = details.providerMessage;
      throw wrapped;
    }
  };
}
