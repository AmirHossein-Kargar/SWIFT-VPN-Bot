import AdminProduct from "../models/AdminProduct.js";

/**
 * Customer-facing selling plans.
 *
 * This is the only source of customer price, duration, and traffic values.
 * The AdminProduct collection remains a separate management/analytics catalog;
 * it is deliberately never consulted by the customer purchase flow.
 */
export const customerPlans = Object.freeze([
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

const customerPlanById = new Map(customerPlans.map((plan) => [plan.id, plan]));

/** Return copies so callers cannot mutate the server-side selling catalog. */
export function getCustomerPlans({ durationDays } = {}) {
  const plans = Number.isSafeInteger(durationDays)
    ? customerPlans.filter((plan) => plan.days === durationDays)
    : customerPlans;
  return plans.map((plan) => ({ ...plan }));
}

/** Resolve only a known customer plan; all customer-supplied terms are ignored. */
export function getCustomerPlanById(planId) {
  if (typeof planId !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(planId)) return null;
  const plan = customerPlanById.get(planId);
  return plan ? { ...plan } : null;
}

export function getCustomerDurations() {
  return [...new Set(customerPlans.map((plan) => plan.days))].sort((a, b) => a - b);
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
