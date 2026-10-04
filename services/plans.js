import AdminProduct from "../models/AdminProduct.js";

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
  const result = await AdminProduct.bulkWrite(operations, { ordered: false });
  return Number(result.upsertedCount || 0);
}

/**
 * The Telegram shop reads from the same product collection used by the Admin
 * Panel. The static catalog remains a safe fallback for tests/development and
 * lets a DB outage never turn the existing checkout into an empty menu.
 */
export async function getActiveProducts({ durationDays } = {}) {
  try {
    const query = { enabled: true };
    if (Number.isSafeInteger(durationDays)) query.durationDays = durationDays;
    const [products, catalogSize] = await Promise.all([
      AdminProduct.find(query).sort({ displayOrder: 1, productId: 1 }).lean(),
      AdminProduct.countDocuments({}),
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

export async function getActiveProductById(productId) {
  if (typeof productId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(productId)) return null;
  try {
    const [product, catalogSize] = await Promise.all([
      AdminProduct.findOne({ productId, enabled: true }).lean(),
      AdminProduct.countDocuments({}),
    ]);
    if (product) return productToPlan(product);
    if (catalogSize > 0) return null;
  } catch {
    // Fall through to the compatibility catalog if Mongo is unavailable.
  }
  return defaultPlans.find((plan) => plan.id === productId) || null;
}

export { defaultPlans, productToPlan };
