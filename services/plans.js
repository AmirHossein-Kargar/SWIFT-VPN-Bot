import mongoose from "mongoose";
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
/** Without a live Mongo connection (unit tests, early boot) the shipped catalog is used instead of buffering queries. */
function catalogDbReady() { return Boolean(injectedProductModel) || mongoose.connection.readyState === 1; }

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SUPPORTED_DAYS = new Set(SUBSCRIPTION_DURATIONS);
/** Matches products that were never archived (field absent) or were restored (null). */
const NOT_ARCHIVED = { archivedAt: null };

function productToPlan(product) {
  return {
    id: String(product.productId ?? product.id),
    name: String(product.name),
    days: Number(product.durationDays ?? product.days),
    gig: Number(product.trafficGb ?? product.gig),
    price: Number(product.priceToman ?? product.price),
  };
}

/** Customer-safe plan (same shape as `customerPlans`): never carries cost or profit. */
function productToCustomerPlan(product) {
  const plan = productToPlan(product);
  const duration = DURATION_OPTION_BY_DAYS.get(plan.days);
  return { ...plan, ...(duration ? { durationLabel: duration.title } : {}) };
}

/** A permanent delete holds this lock only for milliseconds; a lock older than this is a crashed delete and is ignored. */
export const DELETE_LOCK_MS = 120_000;

export function isDeleteLocked(product, nowMs = Date.now()) {
  const lockedAt = product?.deleteLockedAt ? new Date(product.deleteLockedAt).getTime() : 0;
  return lockedAt > 0 && nowMs - lockedAt < DELETE_LOCK_MS;
}

/** A product is sellable only when it is enabled, not archived, not being deleted, and uses a supported duration. */
export function isProductSellable(product, { storefront = false } = {}) {
  if (!product || product.enabled !== true || product.archivedAt || isDeleteLocked(product)) return false;
  if (!SUPPORTED_DAYS.has(Number(product.durationDays))) return false;
  if (storefront && product.published === false) return false;
  return true;
}

const LEGACY_DEFAULT_IDS = defaultPlans.map((plan) => plan.id);

/** Ids that ship with the code (current and legacy). They are re-seeded or referenced by history, so never hard-deleted. */
export function isShippedPlanId(productId) {
  return internalPlanById.has(productId) || legacyPlanById.has(productId) || LEGACY_DEFAULT_IDS.includes(productId);
}

/**
 * Import the shipped customer catalog as durable products without overwriting admin edits, and retire the legacy
 * `plan30_*`/`plan60_*`/`plan90_*` rows (never sold to customers) so they cannot become purchasable. Both steps are
 * idempotent: retirement only touches rows that were never archived or restored.
 * @returns {Promise<number>} number of newly inserted products
 */
export async function seedDefaultProducts() {
  const operations = internalPlanCatalog.map((plan, displayOrder) => ({
    updateOne: {
      filter: { productId: plan.id },
      update: {
        $setOnInsert: {
          productId: plan.id,
          name: plan.name,
          durationDays: plan.days,
          trafficGb: plan.gig,
          priceToman: plan.sellingPrice,
          costToman: plan.purchaseCost,
          enabled: true,
          published: true,
          displayOrder,
          revision: 0,
        },
      },
      upsert: true,
    },
  }));
  const result = await productModel().bulkWrite(operations, { ordered: false });
  await productModel().updateMany(
    { productId: { $in: LEGACY_DEFAULT_IDS }, archivedAt: { $exists: false } },
    { $set: { enabled: false, published: false, archivedAt: new Date(), archivedBy: "system" }, $inc: { revision: 1 } },
  );
  return Number(result.upsertedCount || 0);
}

function staticSellablePlans({ durationDays } = {}) {
  return getCustomerPlans(Number.isSafeInteger(durationDays) ? { durationDays } : {})
    .filter((plan) => customerPlans.some((candidate) => candidate.id === plan.id));
}

/**
 * Plans offered for NEW purchases. The admin product collection is authoritative once it holds any product (so
 * disabling or archiving everything yields an empty menu, never the shipped prices). The shipped catalog is used only
 * when the collection is empty or the database is unreachable, so a DB outage never turns the menu into nothing.
 * `storefront: true` additionally requires the product to be published on the public storefront.
 */
export async function getSellablePlans({ durationDays, storefront = false, requireDatabase = false } = {}) {
  if (Number.isSafeInteger(durationDays) && !SUPPORTED_DAYS.has(durationDays)) return [];
  if (!catalogDbReady()) {
    if (requireDatabase) throw new Error("Product catalog database is not connected");
    return staticSellablePlans({ durationDays });
  }
  try {
    const query = { enabled: true, ...NOT_ARCHIVED, durationDays: Number.isSafeInteger(durationDays) ? durationDays : { $in: [...SUPPORTED_DAYS] } };
    if (storefront) query.published = { $ne: false };
    const [products, catalogSize] = await Promise.all([
      productModel().find(query).sort({ displayOrder: 1, productId: 1 }).lean(),
      productModel().countDocuments({}),
    ]);
    if (catalogSize > 0) return products.filter((product) => isProductSellable(product, { storefront })).map(productToCustomerPlan);
  } catch (error) {
    // Display listings fall back to the shipped catalog; authorization callers pass requireDatabase and fail closed.
    if (requireDatabase) throw error;
  }
  return staticSellablePlans({ durationDays });
}

/**
 * Authoritative lookup used at every purchase step (menu, confirmation, charge, quote, storefront hand-off).
 * A product present in the database decides on its own: disabled, archived, unpublished (storefront) or unsupported
 * means null. An id absent from the database falls back to the shipped catalog (legacy ids only when not storefront).
 * Database errors propagate so a purchase never proceeds on unknown state.
 */
export async function getSellablePlanById(productId, { storefront = false, requireDatabase = false } = {}) {
  if (typeof productId !== "string" || !PRODUCT_ID_PATTERN.test(productId)) return null;
  if (!catalogDbReady()) {
    // Purchase authorization must never fall back to stale shipped data because the database is unreachable.
    if (requireDatabase) throw new Error("Product catalog database is not connected");
    return shippedPlan(productId, storefront);
  }
  const product = await productModel().findOne({ productId }).lean();
  if (product) return isProductSellable(product, { storefront }) ? productToCustomerPlan(product) : null;
  return shippedPlan(productId, storefront);
}

/**
 * Second half of the delete/purchase handshake. deleteProduct locks the product, then counts references, then
 * deletes; a purchase creates its order record first and calls this afterwards. Because the lock is written before
 * the count and this read happens after the record exists, either the delete sees the order (and aborts) or this
 * sees the lock/absence (and the order is withdrawn). Returns false when the product may no longer be referenced.
 */
export async function isProductReferencable(productId, { requireDatabase = false } = {}) {
  if (!catalogDbReady()) {
    if (requireDatabase) throw new Error("Product catalog database is not connected");
    return true;
  }
  const product = await productModel().findOne({ productId }).lean();
  if (product) return !isDeleteLocked(product);
  return isShippedPlanId(productId);
}

function shippedPlan(productId, storefront) {
  if (storefront && !customerPlans.some((plan) => plan.id === productId)) return null;
  return getCustomerPlanById(productId);
}

/** Admin-facing alias kept for existing callers (financial report, tests): plans currently on sale in the bot. */
export const getActiveProducts = getSellablePlans;
export const getActiveProductById = getSellablePlanById;

/** Duration groups offered by the shop. The four subscription durations are fixed; this lists the ones with a sellable plan. */
export async function getAvailableDurations() {
  const plans = await getSellablePlans();
  const present = new Set(plans.map((plan) => plan.days));
  return SUBSCRIPTION_DURATIONS.filter((days) => present.has(days));
}

export { defaultPlans, productToPlan };
