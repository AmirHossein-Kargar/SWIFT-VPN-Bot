"use client";

import { AdminApiError } from "./types";

async function parseOrThrow(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new AdminApiError(body?.message || "The request failed.", response.status, body?.error || "request_failed");
  }
  return body;
}

export async function adminGet<T>(path: string, searchParams?: Record<string, string | number | undefined>): Promise<T> {
  const query = new URLSearchParams();
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
  }
  const queryString = query.toString();
  const response = await fetch(`/api/admin${path}${queryString ? `?${queryString}` : ""}`);
  const body = await parseOrThrow(response);
  return body.data as T;
}

export async function adminMutate<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  csrfToken: string,
  payload?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await parseOrThrow(response);
  return body.data as T;
}

export function newOperationId(): string {
  return crypto.randomUUID();
}
