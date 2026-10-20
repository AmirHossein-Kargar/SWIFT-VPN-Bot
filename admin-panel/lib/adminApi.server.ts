import "server-only";
import { headers } from "next/headers";
import { AdminApiError } from "./types";

function internalBaseUrl(): string {
  const port = process.env.PORT && /^\d+$/.test(process.env.PORT) ? process.env.PORT : "3000";
  return `http://127.0.0.1:${port}`;
}

/**
 * Server-side reads call the existing /api/admin REST surface over the
 * in-process loopback, forwarding the browser's session cookie. This keeps
 * the Express app as the single source of truth for admin data and auth
 * instead of importing its service modules (which Next would bundle into a
 * separate copy, breaking the shared Mongo/Redis/bot singletons).
 */
export async function adminApiGet<T>(path: string, searchParams?: Record<string, string | number | undefined>): Promise<T> {
  const cookie = (await headers()).get("cookie") ?? "";
  const url = new URL(`/api/admin${path}`, internalBaseUrl());
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    headers: { cookie },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new AdminApiError(body?.message || "The admin API request failed.", response.status, body?.error || "request_failed");
  }
  return body.data as T;
}

export interface AdminSessionResult {
  reachable: boolean;
  unavailable: boolean;
  authenticated: boolean;
  actorTelegramId?: string;
  csrfToken?: string;
}

/**
 * Never throws: a network-level failure (the Express app not yet listening,
 * or unreachable) and a 503 from the session store both fall out as
 * `unavailable`, which the (app) layout renders as an error state rather than
 * a false "not signed in" redirect.
 */
export async function adminSession(): Promise<AdminSessionResult> {
  const cookie = (await headers()).get("cookie") ?? "";
  let response: Response;
  try {
    response = await fetch(new URL("/api/admin/auth/session", internalBaseUrl()), {
      headers: { cookie },
      cache: "no-store",
    });
  } catch {
    return { reachable: false, unavailable: true, authenticated: false };
  }
  if (response.status === 503) return { reachable: true, unavailable: true, authenticated: false };
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) return { reachable: true, unavailable: true, authenticated: false };
  return {
    reachable: true,
    unavailable: false,
    authenticated: Boolean(body.authenticated),
    actorTelegramId: body.actorTelegramId,
    csrfToken: body.csrfToken,
  };
}
