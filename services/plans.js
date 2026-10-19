import AdminProduct from "../models/AdminProduct.js";

export const SUBSCRIPTION_DURATION_OPTIONS = Object.freeze([
  { days: 30, months: 1, title: "یک‌ماهه", label: "🗓️ یک‌ماهه" },
  { days: 90, months: 3, title: "سه‌ماهه", label: "🗓️ سه‌ماهه" },
  { days: 180, months: 6, title: "شش‌ماهه", label: "🗓️ شش‌ماهه" },
  { days: 365, months: 12, title: "یک‌ساله", label: "🗓️ یک‌ساله" },
].map((option) => Object.freeze(option)));

export const SUBSCRIPTION_DURATIONS = Object.freeze(
  SUBSCRIPTION_DURATION_OPTIONS.map((option) => option.days),
);

const DURATION_OPTION_BY_DAYS = new Map(
  SUBSCRIPTION_DURATION_OPTIONS.map((option) => [option.days, option]),
);

/**
 * Integer-safe profit calculation: profit = sellingPrice - purchaseCost.
 */
export function calculatePlanProfit(sellingPrice, purchaseCost) {
  if (!Number.isSafeInteger(sellingPrice) || !Number.isSafeInteger(purchaseCost)) {
    throw new TypeError("sellingPrice and purchaseCost must be safe integers");
  }
  return sellingPrice - purchaseCost;
}

const RAW_SUBSCRIPTION_CATALOG = [
  // 30-Day Plans (یک‌ماهه)
  { days: 30, gig: 10, purchaseCost: 13_000, sellingPrice: 20_000 },
  { days: 30, gig: 30, purchaseCost: 33_000, sellingPrice: 50_000 },
  { days: 30, gig: 50, purchaseCost: 53_000, sellingPrice: 80_000 },
  { days: 30, gig: 100, purchaseCost: 103_000, sellingPrice: 155_000 },
  { days: 30, gig: 200, purchaseCost: 203_000, sellingPrice: 305_000 },
  { days: 30, gig: 300, purchaseCost: 303_000, sellingPrice: 455_000 },
  { days: 30, gig: 500, purchaseCost: 503_000, sellingPrice: 755_000 },

  // 90-Day Plans (سه‌ماهه)
  { days: 90, gig: 30, purchaseCost: 39_000, sellingPrice: 59_000 },
  { days: 90, gig: 50, purchaseCost: 59_000, sellingPrice: 89_000 },
  { days: 90, gig: 100, purchaseCost: 109_000, sellingPrice: 164_000 },
  { days: 90, gig: 200, purchaseCost: 209_000, sellingPrice: 314_000 },
  { days: 90, gig: 300, purchaseCost: 309_000, sellingPrice: 464_000 },
  { days: 90, gig: 500, purchaseCost: 509_000, sellingPrice: 764_000 },

  // 180-Day Plans (شش‌ماهه)
  { days: 180, gig: 30, purchaseCost: 48_000, sellingPrice: 72_000 },
  { days: 180, gig: 50, purchaseCost: 68_000, sellingPrice: 102_000 },
  { days: 180, gig: 100, purchaseCost: 118_000, sellingPrice: 177_000 },
  { days: 180, gig: 200, purchaseCost: 218_000, sellingPrice: 327_000 },
  { days: 180, gig: 300, purchaseCost: 318_000, sellingPrice: 477_000 },
  { days: 180, gig: 500, purchaseCost: 518_000, sellingPrice: 777_000 },

  // 365-Day Plans (یک‌ساله)
  { days: 365, gig: 30, purchaseCost: 66_500, sellingPrice: 100_000 },
  { days: 365, gig: 50, purchaseCost: 86_500, sellingPrice: 130_000 },
  { days: 365, gig: 100, purchaseCost: 136_500, sellingPrice: 205_000 },
  { days: 365, gig: 200, purchaseCost: 236_500, sellingPrice: 355_000 },
  { days: 365, gig: 300, purchaseCost: 336_500, sellingPrice: 505_000 },
  { days: 365, gig: 500, purchaseCost: 536_500, sellingPrice: 805_000 },
];

/**
 * Authoritative internal pricing catalog containing purchaseCost, sellingPrice, and profit.
 * Internal fields (purchaseCost, profit) must NEVER be exposed in customer-facing responses.
 */
const internalPlanCatalog = Object.freeze(
  RAW_SUBSCRIPTION_CATALOG.map(({ days, gig, purchaseCost, sellingPrice }) => {
    const durationMeta = DURATION_OPTION_BY_DAYS.get(days);
    const durationLabel = durationMeta ? durationMeta.title : `${days} روزه`;
    const profit = calculatePlanProfit(sellingPrice, purchaseCost);
    return Object.freeze({
      id: `s${days}_${gig}`,
      name: `${gig} گیگابایت — ${durationLabel}`,
      days,
      durationLabel,
      gig,
      purchaseCost,
      sellingPrice,
      price: sellingPrice,
      profit,
    });
  }),
);

function toCustomerPlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    name: plan.name,
    days: plan.days,
    ...(plan.durationLabel ? { durationLabel: plan.durationLabel } : {}),
    gig: plan.gig,
    price: plan.price,
  };
}

/**
 * Customer-facing selling plans (strictly sanitized — no purchaseCost or profit fields).
 */
export const customerPlans = Object.freeze(
  internalPlanCatalog.map((plan) => Object.freeze(toCustomerPlan(plan))),
);

/**
 * Legacy customer plan identifiers retained for backward compatibility with
 * historical orders, invoices, and existing unit/integration tests.
 */
export const legacyCustomerPlans = Object.freeze([
  { id: "test", name: "Test", days: 1, gig: 1, price: 1_000 },
  { id: "mini", name: "Mini", days: 7, gig: 5, price: 25_000 },
  { id: "basic", name: "Basic", days: 15, gig: 10, price: 45_000 },
  { id: "standard", name: "Standard", days: 30, gig: 20, price: 79_000 },
  { id: "plus", name: "Plus", days: 30, gig: 30, price: 109_000 },
  { id: "pro", name: "Pro", days: 30, gig: 50, price: 169_000 },
  { id: "premium", name: "Premium", days: 30, gig: 75, price: 229_000 },
  { id: "ultra", name: "Ultra", days: 30, gig: 100, price: 279_000 },
  { id: "max", name: "Max", days: 30, gig: 150, price: 389_000 },
  { id: "max_plus", name: "Max+", days: 30, gig: 200, price: 499_000 },
].map((plan) => Object.freeze(plan)));

const internalPlanById = new Map(internalPlanCatalog.map((plan) => [plan.id, plan]));
const internalPlanByDurationAndGig = new Map(
  internalPlanCatalog.map((plan) => [`${plan.days}:${plan.gig}`, plan]),
);
const legacyPlanById = new Map(legacyCustomerPlans.map((plan) => [plan.id, plan]));

/** Return customer-safe copies (never includes purchaseCost or profit). */
export function getCustomerPlans({ durationDays } = {}) {
  if (!Number.isSafeInteger(durationDays)) {
    return customerPlans.map((plan) => ({ ...plan }));
  }
  const matching = customerPlans.filter((plan) => plan.days === durationDays);
  if (matching.length > 0) {
    return matching.map((plan) => ({ ...plan }));
  }
  return legacyCustomerPlans
    .filter((plan) => plan.days === durationDays)
    .map((plan) => ({ ...plan }));
}

/** Resolve only a known customer plan; returns only customer-safe fields. */
export function getCustomerPlanById(planId) {
  if (typeof planId !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(planId)) return null;
  const activePlan = internalPlanById.get(planId);
  if (activePlan) {
    return toCustomerPlan(activePlan);
  }
  const legacyPlan = legacyPlanById.get(planId);
  if (legacyPlan) {
    return { ...legacyPlan };
  }
  return null;
}

/** Resolve a customer-safe plan by (durationDays, gig). */
export function getCustomerPlanByDurationAndVolume(durationDays, gig) {
  if (!Number.isSafeInteger(durationDays) || !Number.isSafeInteger(gig)) return null;
  const plan = internalPlanByDurationAndGig.get(`${durationDays}:${gig}`);
  return plan ? toCustomerPlan(plan) : null;
}

/** Backend/admin-only helpers returning internal purchaseCost, sellingPrice, and profit. */
export function getInternalPlanCatalog({ durationDays } = {}) {
  const list = Number.isSafeInteger(durationDays)
    ? internalPlanCatalog.filter((plan) => plan.days === durationDays)
    : internalPlanCatalog;
  return list.map((plan) => ({ ...plan }));
}

export function getInternalPlanById(planId) {
  if (typeof planId !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(planId)) return null;
  const plan = internalPlanById.get(planId);
  return plan ? { ...plan } : null;
}

export function getInternalPlanByDurationAndVolume(durationDays, gig) {
  if (!Number.isSafeInteger(durationDays) || !Number.isSafeInteger(gig)) return null;
  const plan = internalPlanByDurationAndGig.get(`${durationDays}:${gig}`);
  return plan ? { ...plan } : null;
}

export function getCustomerDurations() {
  return [...SUBSCRIPTION_DURATIONS];
}

export function getSubscriptionDurations() {
  return [...SUBSCRIPTION_DURATIONS];
}

export function getSubscriptionDurationOptions() {
  return SUBSCRIPTION_DURATION_OPTIONS.map((option) => ({ ...option }));
}

export function getDurationOptionByDays(days) {
  const option = DURATION_OPTION_BY_DAYS.get(Number(days));
  return option ? { ...option } : null;
}

export const plans30 = [
  { id: "plan30_10", name: "🔹 10 گیگ - 30 روزه", days: 30, gig: 10, price: 18000 },
  { id: "plan30_50", name: "🔹 50 گیگ - 30 روزه", days: 30, gig: 50, price: 42000 },
  { id: "plan30_100", name: "🔹 100 گیگ - 30 روزه", days: 30, gig: 100, price: 72000 },
  { id: "plan30_200", name: "🔹 200 گیگ - 30 روزه", days: 30, gig: 200, price: 132000 },
];

export const plans60 = [
  { id: "plan60_50", name: "🔸 50 گیگ - 60 روزه", days: 60, gig: 50, price: 54000 },
  { id: "plan60_100", name: "🔸 100 گیگ - 60 روزه", days: 60, gig: 100, price: 84000 },
  { id: "plan60_200", name: "🔸 200 گیگ - 60 روزه", days: 60, gig: 200, price: 144000 },
  { id: "plan60_300", name: "🔸 300 گیگ - 60 روزه", days: 60, gig: 300, price: 204000 },
  { id: "plan60_400", name: "🔸 400 گیگ - 60 روزه", days: 60, gig: 400, price: 264000 },
  { id: "plan60_500", name: "🔸 500 گیگ - 60 روزه", days: 60, gig: 500, price: 324000 },
];

export const plans90 = [
  { id: "plan90_100", name: "🔷 100 گیگ - 90 روزه", days: 90, gig: 100, price: 96000 },
  { id: "plan90_200", name: "🔷 200 گیگ - 90 روزه", days: 90, gig: 200, price: 156000 },
  { id: "plan90_300", name: "🔷 300 گیگ - 90 روزه", days: 90, gig: 300, price: 216000 },
  { id: "plan90_500", name: "🔷 500 گیگ - 90 روزه", days: 90, gig: 500, price: 336000 },
  { id: "plan90_700", name: "🔷 700 گیگ - 90 روزه", days: 90, gig: 700, price: 456000 },
  { id: "plan90_1000", name: "🔷 1 ترابایت - 90 روزه", days: 90, gig: 1000, price: 636000 },
];

const defaultPlans = [...plans30, ...plans60, ...plans90];
const DEFAULT_DURATIONS = [30, 60, 90];

// Test seam: unit tests inject an in-memory model so the shop catalog logic
// can be verified without MongoDB (integration tests use the real model).
let injectedProductModel = null;
export function setProductModelForTests(model) { injectedProductModel = model; }
function productModel() { return injectedProductModel || AdminProduct; }

function productToPlan(product) {
  return {
    id: String(product.productId ?? product.id),
    name: String(product.name),
    days: Number(product.durationDays ?? product.days),
    gig: Number(product.trafficGb ?? product.gig),
    price: Number(product.priceToman ?? product.price),
  };
}

/** Add the currently shipped plans as durable products without overwriting admin edits. */
export async function seedDefaultProducts() {
  const costPerDay = Number(process.env.COST_PER_DAY || 200);
  const costPerGb = Number(process.env.COST_PER_GB || 300);
  const operations = defaultPlans.map((plan, displayOrder) => ({
    updateOne: {
      filter: { productId: plan.id },
      update: {
        $setOnInsert: {
          productId: plan.id,
          name: plan.name,
          durationDays: plan.days,
          trafficGb: plan.gig,
          priceToman: plan.price,
          costToman: Math.max(0, Math.round(plan.days * costPerDay + plan.gig * costPerGb)),
          enabled: true,
          displayOrder,
        },
      },
      upsert: true,
    },
  }));
  const result = await productModel().bulkWrite(operations, { ordered: false });
  return Number(result.upsertedCount || 0);
}

/**
 * The Telegram shop reads from the same product collection used by the Admin
 * Panel — this is the authoritative source of purchasable products and their
 * prices. The static catalog remains a safe fallback for tests/development and
 * lets a DB outage never turn the existing checkout into an empty menu.
 */
export async function getActiveProducts({ durationDays } = {}) {
  try {
    const query = { enabled: true };
    if (Number.isSafeInteger(durationDays)) query.durationDays = durationDays;
    const [products, catalogSize] = await Promise.all([
      productModel().find(query).sort({ displayOrder: 1, productId: 1 }).lean(),
      productModel().countDocuments({}),
    ]);
    if (catalogSize > 0) return products.map(productToPlan);
  } catch {
    // The bot's current payment paths already depend on Mongo. Keeping the
    // shipped plan fallback avoids introducing an additional failure mode.
  }
  const selected = Number.isSafeInteger(durationDays)
    ? defaultPlans.filter((plan) => plan.days === durationDays)
    : defaultPlans;
  return selected.map(productToPlan);
}

/**
 * The authoritative price/product lookup for checkout. When the catalog is
 * populated, a product that is missing or disabled there returns null —
 * stale hardcoded prices can never override database products.
 */
export async function getActiveProductById(productId) {
  if (typeof productId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(productId)) return null;
  try {
    const [product, catalogSize] = await Promise.all([
      productModel().findOne({ productId, enabled: true }).lean(),
      productModel().countDocuments({}),
    ]);
    if (product) return productToPlan(product);
    if (catalogSize > 0) return null;
  } catch {
    // Fall through to the compatibility catalog if Mongo is unavailable.
  }
  return defaultPlans.find((plan) => plan.id === productId) || null;
}

/**
 * Duration groups offered by the shop, derived from the active catalog so a
 * product created in the admin panel appears in the shop automatically.
 * Falls back to the shipped 30/60/90 groups when the catalog is empty or the
 * database is unreachable.
 */
export async function getAvailableDurations() {
  try {
    const products = await getActiveProducts();
    const durations = [...new Set(products.map((plan) => Number(plan.days)).filter(Number.isSafeInteger))]
      .sort((a, b) => a - b);
    if (durations.length) return durations;
  } catch {
    // fall through to shipped durations
  }
  return DEFAULT_DURATIONS;
}

export { defaultPlans, productToPlan };
