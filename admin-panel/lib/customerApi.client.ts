"use client";

import { AdminApiError } from "./types";

async function parseOrThrow(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new AdminApiError(body?.message || "درخواست انجام نشد.", response.status, body?.error || "request_failed");
  }
  return body;
}

export async function customerMutate<T>(path: string, csrfToken: string | null, payload?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/support${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await parseOrThrow(response);
  return body as T;
}

export function newOperationId(): string {
  return crypto.randomUUID();
}
