const REQUEST_TIMEOUT_MS = 10_000;

export class StoreApiError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "StoreApiError";
    this.status = status;
  }
}

/**
 * GET a /api/store endpoint; resolves with `data`, rejects with StoreApiError (with HTTP status when known).
 * `fresh` bypasses the browser's 60 s HTTP cache: used by retries and by the background refresh that follows
 * "this plan is no longer sold", which must see the server's current catalog, not the one fetched a moment ago.
 */
export async function getStoreJson<T>(path: string, signal?: AbortSignal, options: { fresh?: boolean } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(path, { headers: { accept: "application/json" }, signal: controller.signal, credentials: "omit", cache: options.fresh ? "reload" : "default" });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok !== true) throw new StoreApiError(body?.error || "request_failed", response.status);
    return body.data as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
