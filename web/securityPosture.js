/**
 * What the settings page reports about admin web protection. Nothing here is a stored flag: each answer comes from walking
 * the router that is really mounted and from running the real middleware against synthetic requests, so a removed guard or
 * a broken check reads as `failed`. It proves what this process enforces, not what a proxy in front of it does to responses.
 *
 * Status values: `verified` (checked just now), `attention` (works, but the evidence or configuration is incomplete),
 * `failed` (a check did not hold), `not_applicable`.
 */
import { requireAdminSession, requireCsrfForActiveSession, requireCsrfToken, requireSameOrigin } from "./adminMiddleware.js";
import { applyNextPanelHeaders } from "./nextAdminMiddleware.js";
import { apiCors, lastHstsSentAt, readTrustedOrigins, SAFE_METHODS } from "./webSecurity.js";

/** Sign-in cannot have a session token yet. The Origin check and the single-use code protect these two. */
export const PRE_SESSION_ROUTES = Object.freeze(["/auth/request-code", "/auth/verify"]);

const PROBE_ORIGIN = "https://security-probe.invalid";
const PROBE_TOKEN = "security-probe-token";

function run(middleware, { method = "POST", headers = {}, session } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const responseHeaders = {};
  let outcome = "no_answer";
  const res = {
    vary() { return res; },
    set(name, value) { responseHeaders[name.toLowerCase()] = value; return res; },
    status(code) { outcome = code; return res; },
    json() { return res; },
    end() { return res; },
  };
  const req = {
    method,
    protocol: "https",
    adminSession: session,
    get: (name) => (name.toLowerCase() === "host" ? "security-probe.local" : lower[name.toLowerCase()]),
  };
  middleware(req, res, () => { outcome = "passed"; });
  return { outcome, headers: responseHeaders };
}

/** Classifies every state-changing route, including routers mounted below the guards. */
export function auditRouteCoverage(router) {
  const stack = Array.isArray(router?.stack) ? router.stack : [];
  const sessionAt = stack.findIndex((layer) => layer.handle === requireAdminSession);
  const csrfAt = stack.findIndex((layer) => layer.handle === requireCsrfToken);
  const guardAt = sessionAt < 0 || csrfAt < 0 ? Number.POSITIVE_INFINITY : Math.max(sessionAt, csrfAt);
  const report = { stateChangingRoutes: 0, tokenRequiredRoutes: 0, sessionBoundRoutes: 0, preSessionRoutes: 0, unprotectedRoutes: [] };

  const visit = (layers, guarded) => {
    layers.forEach((layer, index) => {
      const covered = guarded || index > guardAt;
      if (Array.isArray(layer.handle?.stack)) visit(layer.handle.stack, covered);
      if (!layer.route) return;
      for (const method of Object.keys(layer.route.methods).map((name) => name.toUpperCase())) {
        if (SAFE_METHODS.has(method)) continue;
        report.stateChangingRoutes += 1;
        if (covered) report.tokenRequiredRoutes += 1;
        else if (layer.route.stack.some((step) => step.handle === requireCsrfForActiveSession)) report.sessionBoundRoutes += 1;
        else if (PRE_SESSION_ROUTES.includes(layer.route.path)) report.preSessionRoutes += 1;
        else report.unprotectedRoutes.push(`${method} ${layer.route.path}`);
      }
    });
  };
  visit(stack, false);
  return report;
}

function csrfStatus(coverage, csrfMiddleware) {
  const session = { csrfToken: PROBE_TOKEN };
  const probes = [
    run(csrfMiddleware, { session }).outcome === 403,
    run(csrfMiddleware, { session, headers: { "x-csrf-token": `${PROBE_TOKEN}x` } }).outcome === 403,
    run(csrfMiddleware, { session: { csrfToken: "" }, headers: { "x-csrf-token": "" } }).outcome === 403,
    run(csrfMiddleware, { session, headers: { "x-csrf-token": PROBE_TOKEN } }).outcome === "passed",
  ];
  return coverage.stateChangingRoutes > 0 && coverage.unprotectedRoutes.length === 0 && probes.every(Boolean) ? "verified" : "failed";
}

function originStatus(trusted, originMiddleware) {
  const probes = [
    run(originMiddleware, { headers: { origin: PROBE_ORIGIN } }).outcome === 403,
    run(originMiddleware, { headers: { origin: "null" } }).outcome === 403,
    run(originMiddleware, { method: "GET", headers: { origin: PROBE_ORIGIN } }).outcome === 403,
    run(originMiddleware, { method: "GET", headers: { "sec-fetch-site": "cross-site" } }).outcome === 403,
  ];
  if (!probes.every(Boolean)) return "failed";
  // Production with nothing configured refuses every browser: safe, but the panel cannot be used.
  const complete = trusted.production && trusted.origins.size > 0 && trusted.ignored === 0;
  return complete ? "verified" : "attention";
}

function corsStatus(corsMiddleware) {
  const refused = run(corsMiddleware, { method: "OPTIONS", headers: { origin: PROBE_ORIGIN, "access-control-request-method": "POST" } });
  const plain = run(corsMiddleware, { method: "GET", headers: { origin: PROBE_ORIGIN } });
  const held = refused.outcome === 403 && !refused.headers["access-control-allow-origin"] && !plain.headers["access-control-allow-origin"];
  return held ? "verified" : "failed";
}

function headerStatus() {
  const sent = {};
  const req = { secure: false, headers: {} };
  applyNextPanelHeaders(req, { setHeader: (name, value) => { sent[name.toLowerCase()] = value; } });
  const csp = sent["content-security-policy"] ?? "";
  const scriptSource = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src ")) ?? "";
  const ok = /'nonce-[A-Za-z0-9+/=]+'/.test(scriptSource)
    && !scriptSource.includes("'unsafe-inline'")
    && /frame-ancestors 'none'/.test(csp)
    && /object-src 'none'/.test(csp)
    && /base-uri 'none'/.test(csp)
    && sent["x-frame-options"] === "DENY"
    && sent["x-content-type-options"] === "nosniff"
    && sent["referrer-policy"] === "same-origin"
    && /camera=\(\)/.test(sent["permissions-policy"] ?? "");
  return ok ? "verified" : "failed";
}

function hstsStatus(production) {
  const sentAt = lastHstsSentAt();
  if (sentAt) return { status: "verified", lastSentAt: new Date(sentAt).toISOString() };
  return { status: production ? "attention" : "not_applicable", lastSentAt: null };
}

/** Never throws: a check that cannot run is a failed check, not a page error or a pass. */
export function inspectAdminSecurity(router, {
  csrfMiddleware = requireCsrfToken,
  originMiddleware = requireSameOrigin,
  corsMiddleware = apiCors,
  now = new Date(),
} = {}) {
  const attempt = (check) => { try { return check(); } catch { return "failed"; } };
  const trusted = readTrustedOrigins();
  const coverage = auditRouteCoverage(router);
  return {
    checkedAt: now.toISOString(),
    csrf: { status: attempt(() => csrfStatus(coverage, csrfMiddleware)), ...coverage },
    origin: {
      status: attempt(() => originStatus(trusted, originMiddleware)),
      mode: trusted.production ? "allow-list" : "request-host",
      trustedOrigins: trusted.origins.size,
      ignoredEntries: trusted.ignored,
    },
    cors: { status: attempt(() => corsStatus(corsMiddleware)) },
    headers: { status: attempt(headerStatus) },
    hsts: hstsStatus(trusted.production),
  };
}
