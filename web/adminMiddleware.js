import { timingSafeEqual } from "node:crypto";
import { ADMIN_SESSION_COOKIE, getAdminSession } from "../services/admin/auth.js";
import { AdminServiceError } from "../services/admin/authorization.js";

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 20_000;

const buckets = new Map();

export function clientIp(req) {
  return typeof req.ip === "string" && req.ip ? req.ip : "unknown";
}

export function resetAdminRateLimitsForTests() {
  buckets.clear();
}

/**
 * Bounded in-memory limiter for admin API routes. Railway runs this app as a
 * single replica (a hard requirement of the Telegram polling bot), so a
 * process-local limiter is sufficient and keeps Redis free for money-critical
 * locks and sessions.
 */
export function adminRateLimit({ key, limit, windowMs = WINDOW_MS }) {
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) {
    for (const [bucketKey, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(bucketKey);
    }
    if (buckets.size > MAX_BUCKETS) buckets.clear();
  }
  const existing = buckets.get(key);
  if (!existing || now >= existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }
  existing.count += 1;
  if (existing.count > limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: Math.ceil(windowMs / 1000) };
}

export function rateLimitMiddleware({ limit, windowMs } = {}) {
  const resolvedLimit = Number.isInteger(limit) && limit > 0 ? limit : 240;
  return (req, res, next) => {
    const result = adminRateLimit({ key: `${req.baseUrl}${req.path}:${clientIp(req)}`, limit: resolvedLimit, windowMs });
    if (!result.allowed) {
      res.set("Retry-After", String(result.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: "rate_limited", retry_after_seconds: result.retryAfterSeconds });
    }
    next();
  };
}

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== "string" || !header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function sessionCookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds * 1000,
  };
}

export function attachAdminSession(req, _res, next) {
  (async () => {
    const token = parseCookies(req.get("cookie"))[ADMIN_SESSION_COOKIE];
    if (!token) {
      req.adminSession = null;
      req.adminActorId = null;
      return next();
    }
    try {
      const session = await getAdminSession(token);
      req.adminSessionToken = token;
      req.adminSession = session;
      req.adminActorId = session?.actorTelegramId ?? null;
    } catch (error) {
      // An unavailable session store must fail closed for authenticated routes.
      req.adminSession = null;
      req.adminActorId = null;
      req.adminSessionError = error;
    }
    next();
  })().catch(() => next());
}

export function requireAdminSession(req, _res, next) {
  if (req.adminSessionError) {
    return resSessionUnavailable(req, _res);
  }
  if (!req.adminSession || !req.adminActorId) {
    return _res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function resSessionUnavailable(req, res) {
  return res.status(503).json({ ok: false, error: "session_store_unavailable" });
}

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a ?? ""));
  const bufferB = Buffer.from(String(b ?? ""));
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * CSRF protection. The session cookie is SameSite=Lax, which already blocks
 * cross-site POSTs from plain web pages; the double-submit token below also
 * covers SameSite exemptions (older browsers, Lax+POST) and non-browser
 * clients that somehow obtained the cookie header.
 */
export function requireCsrfToken(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  if (!req.adminSession) return res.status(401).json({ ok: false, error: "unauthorized" });
  const headerToken = req.get("x-csrf-token");
  if (!headerToken || !safeEqual(headerToken, req.adminSession.csrfToken)) {
    return res.status(403).json({ ok: false, error: "csrf_token_invalid" });
  }
  next();
}

export function adminApiErrorHandler(error, req, res, _next) {
  // AdminServiceError and the auth module's HTTP-mapped errors (status + code +
  // safeMessage) are returned as structured responses; anything else is masked.
  if (error instanceof AdminServiceError || (Number.isInteger(error?.status) && typeof error?.code === "string" && typeof error?.safeMessage === "string")) {
    return res.status(error.status || 400).json({ ok: false, error: error.code || "admin_request_failed", message: error.safeMessage });
  }
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    service: "admin-web",
    level: "error",
    message: "Admin API request failed",
    path: req.path,
    method: req.method,
    errorType: error?.name || "Error",
    code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
  }));
  res.status(500).json({ ok: false, error: "internal_error", message: "The request could not be completed." });
}
