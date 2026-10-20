/**
 * Public storefront API (read-only, unauthenticated).
 *
 * It exposes exactly the customer catalog the Telegram shop sells from
 * (services/plans.js `customerPlans`, already stripped of cost/profit) plus the
 * Telegram checkout hand-off. Checkout itself stays in Telegram: the customer's
 * wallet, payment providers and order identity are bound to their Telegram
 * account, and there is no customer web login to attach an order to.
 */
import express from "express";
import { customerPlans, getCustomerPlanById, getSubscriptionDurationOptions } from "../services/plans.js";
import { readNowPaymentsConfig } from "../services/nowpayments/money.js";
import { getSupportContactUrl } from "../messages/supportContact.js";
import { getBotUsername } from "../config/botIdentity.js";
import { clientIp } from "./adminMiddleware.js";

const router = express.Router();
const ACTIVE_PLAN_IDS = new Set(customerPlans.map((plan) => plan.id));

router.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).set("Allow", "GET, HEAD").json({ ok: false, error: "method_not_allowed" });
  }
  next();
});
// Own limiter (not the admin one): public traffic must never be able to evict
// or reset the buckets that protect admin sign-in.
const STORE_LIMIT_PER_MIN = 120;
const STORE_MAX_BUCKETS = 10_000;
const storeBuckets = new Map();
export function resetStoreRateLimitsForTests() { storeBuckets.clear(); }
router.use((req, res, next) => {
  const now = Date.now();
  if (storeBuckets.size >= STORE_MAX_BUCKETS) {
    for (const [key, bucket] of storeBuckets) if (now >= bucket.resetAt) storeBuckets.delete(key);
  }
  const key = clientIp(req);
  let bucket = storeBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (storeBuckets.size >= STORE_MAX_BUCKETS) return res.status(429).set("Retry-After", "60").json({ ok: false, error: "rate_limited" });
    bucket = { count: 0, resetAt: now + 60_000 };
    storeBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > STORE_LIMIT_PER_MIN) {
    res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).json({ ok: false, error: "rate_limited" });
  }
  next();
});

function publicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    days: plan.days,
    durationLabel: plan.durationLabel || null,
    gig: plan.gig,
    price: plan.price,
  };
}

function checkout(env = process.env) {
  const username = getBotUsername(env);
  return username
    ? { channel: "telegram", available: true, botUrl: `https://t.me/${username}`, botUsername: username }
    : { channel: "telegram", available: false, botUrl: null, botUsername: null };
}

export function planCheckoutUrl(planId, env = process.env) {
  const username = getBotUsername(env);
  return username && ACTIVE_PLAN_IDS.has(planId) ? `https://t.me/${username}?start=plan_${planId}` : null;
}

function paymentMethods(env = process.env) {
  let crypto = false;
  try { crypto = Boolean(readNowPaymentsConfig(env)); } catch { crypto = false; }
  return [
    { id: "hooshpay", available: Boolean(env.HOOSHPAY_API_KEY?.trim() && env.HOOSHPAY_WEBHOOK_SECRET?.trim()) },
    { id: "crypto", available: crypto },
  ];
}

export function buildStoreCatalog(env = process.env) {
  const durations = getSubscriptionDurationOptions()
    .map(({ days, months, title }) => ({ days, months, title }))
    .filter((option) => customerPlans.some((plan) => plan.days === option.days));
  return {
    currency: { code: "IRT", unit: "toman" },
    durations,
    plans: customerPlans.map(publicPlan),
    paymentMethods: paymentMethods(env),
    checkout: checkout(env),
    support: { url: getSupportContactUrl() },
    generatedAt: new Date().toISOString(),
  };
}

router.get("/catalog", (_req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  res.json({ ok: true, data: buildStoreCatalog() });
});

/**
 * Server-side validation of a selected plan before hand-off. The response is
 * computed from the catalog; nothing in the request other than the ID is used.
 */
router.get("/plans/:planId", (req, res) => {
  const planId = String(req.params.planId || "");
  const plan = ACTIVE_PLAN_IDS.has(planId) ? getCustomerPlanById(planId) : null;
  res.set("Cache-Control", "public, max-age=60");
  if (!plan) return res.status(404).json({ ok: false, error: "plan_not_available" });
  const checkoutUrl = planCheckoutUrl(plan.id);
  res.json({
    ok: true,
    data: {
      plan: publicPlan(plan),
      checkout: { ...checkout(), url: checkoutUrl, available: Boolean(checkoutUrl) },
    },
  });
});

router.use((_req, res) => res.status(404).json({ ok: false, error: "not_found" }));

export default router;
