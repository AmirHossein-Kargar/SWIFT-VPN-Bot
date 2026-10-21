import "server-only";
import { headers } from "next/headers";
import { AdminApiError } from "./types";

function internalBaseUrl(): string {
  const port = process.env.PORT && /^\d+$/.test(process.env.PORT) ? process.env.PORT : "3000";
  return `http://127.0.0.1:${port}`;
}

/**
 * Customer-area reads go through the same loopback pattern as the admin
 * panel: the Express app owns sessions and ticket ownership checks, this
 * layer only forwards the browser's cookie to /api/support.
 */
export async function customerApiGet<T>(path: string): Promise<T> {
  const cookie = (await headers()).get("cookie") ?? "";
  const response = await fetch(new URL(`/api/support${path}`, internalBaseUrl()), { headers: { cookie }, cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new AdminApiError(body?.message || "The request failed.", response.status, body?.error || "request_failed");
  }
  return body.data as T;
}

export interface CustomerSessionResult {
  unavailable: boolean;
  authenticated: boolean;
  csrfToken?: string;
}

/** Never throws: an unreachable API or session store becomes `unavailable`, not a false sign-out. */
export async function customerSession(): Promise<CustomerSessionResult> {
  const cookie = (await headers()).get("cookie") ?? "";
  try {
    const response = await fetch(new URL("/api/support/auth/session", internalBaseUrl()), { headers: { cookie }, cache: "no-store" });
    if (response.status === 503) return { unavailable: true, authenticated: false };
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) return { unavailable: true, authenticated: false };
    return { unavailable: false, authenticated: Boolean(body.authenticated), csrfToken: body.csrfToken };
  } catch {
    return { unavailable: true, authenticated: false };
  }
}
