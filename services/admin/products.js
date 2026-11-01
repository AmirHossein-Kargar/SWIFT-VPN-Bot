import { randomBytes } from "node:crypto";
import AdminProduct from "../../models/AdminProduct.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import User from "../../models/User.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { parsePositiveInteger, parsePagination, escapeRegex } from "./validation.js";
import { SUBSCRIPTION_DURATIONS, DELETE_LOCK_MS, isShippedPlanId } from "../plans.js";
import { getProviderAccount } from "../wizardAccount.js";
import { UNLIMITED_GB, isUnlimitedTraffic } from "../../utils/serviceTerms.js";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Optional admin-chosen identifier for new products; lowercase so it also works inside bot deep links. */
const CUSTOM_ID_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;
const MAX_REORDER_SCOPE = 1000;

export const PRODUCT_STATUS_FILTERS = Object.freeze(["current", "live", "disabled", "hidden", "archived", "all"]);
export const PRODUCT_SORT_FIELDS = Object.freeze({
  order: "displayOrder",
  name: "name",
  price: "priceToman",
  duration: "durationDays",
  traffic: "trafficGb",
  updated: "updatedAt",
});

const newProductId = () => `svc_${randomBytes(6).toString("hex")}`;

function badProduct(message, code, status = 400, details = null) {
  return new AdminServiceError(message, { status, code, details });
}

function requireProductId(productId) {
  const id = String(productId ?? "");
  if (!PRODUCT_ID_PATTERN.test(id)) throw badProduct("شناسه محصول نامعتبر است.", "invalid_product_id");
  return id;
}

function parseExpectedRevision(input) {
  if (!input || !Object.hasOwn(input, "expectedRevision") || input.expectedRevision == null) return null;
  return parsePositiveInteger(input.expectedRevision, { name: "expected revision", min: 0, max: 2_000_000_000 });
}

/**
 * A blank volume must never become unlimited. parsePositiveInteger reads null and "" as 0, and with a minimum of 0 that would
 * sell unlimited traffic by leaving a field empty, so 0 has to arrive as a real zero.
 */
function parseTraffic(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) throw badProduct("حجم محصول لازم است.", "invalid_traffic_gb");
  return parsePositiveInteger(value, { name: "traffic GB", min: UNLIMITED_GB, max: 10_000 });
}

/** Validates field values. Business rules that need other rows (duplicates, sellability) live in assertSellable. */
function validateProductInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badProduct("اطلاعات محصول لازم است.", "invalid_product");
  const output = {};
  if (!partial || Object.hasOwn(input, "name")) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw badProduct("نام محصول باید ۱ تا ۱۲۰ نویسه قابل نمایش باشد.", "invalid_product_name");
    output.name = name;
  }
  if (!partial || Object.hasOwn(input, "durationDays")) output.durationDays = parsePositiveInteger(input.durationDays, { name: "duration days", min: 1, max: 3650 });
  if (!partial || Object.hasOwn(input, "trafficGb")) output.trafficGb = parseTraffic(input.trafficGb);
  if (!partial || Object.hasOwn(input, "priceToman")) output.priceToman = parsePositiveInteger(input.priceToman, { name: "price", min: 1, max: 2_000_000_000 });
  if (!partial || Object.hasOwn(input, "costToman")) output.costToman = parsePositiveInteger(input.costToman, { name: "cost", min: 0, max: 2_000_000_000 });
  if (!partial || Object.hasOwn(input, "enabled")) {
    if (typeof input.enabled !== "boolean") throw badProduct("وضعیت فعال بودن محصول باید مشخص باشد.", "invalid_product_enabled");
    output.enabled = input.enabled;
  }
  if (Object.hasOwn(input, "published") || !partial) {
    const published = input.published ?? true;
    if (typeof published !== "boolean") throw badProduct("وضعیت انتشار در فروشگاه باید مشخص باشد.", "invalid_product_published");
    output.published = published;
  }
  if (!partial || Object.hasOwn(input, "displayOrder")) output.displayOrder = parsePositiveInteger(input.displayOrder ?? 0, { name: "display order", min: 0, max: 100_000 });
  return output;
}

function present(product, { references = null } = {}) {
  const item = product?.toObject ? product.toObject() : product;
  const id = String(item.productId);
  return {
    id,
    name: item.name,
    durationDays: Number(item.durationDays),
    trafficGb: Number(item.trafficGb),
    unlimited: isUnlimitedTraffic(item.trafficGb),
    priceToman: Number(item.priceToman),
    costToman: Number(item.costToman),
    profitToman: Number(item.priceToman) - Number(item.costToman),
    enabled: Boolean(item.enabled),
    published: item.published !== false,
    archived: Boolean(item.archivedAt),
    archivedAt: item.archivedAt || null,
    revision: Number(item.revision || 0),
    displayOrder: Number(item.displayOrder || 0),
    supportedDuration: SUBSCRIPTION_DURATIONS.includes(Number(item.durationDays)),
    system: isShippedPlanId(id),
    ...(references == null ? {} : { references }),
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

/**
 * Rules for a product that customers can buy (enabled, not archived). Such a product must be fulfillable by the
 * provider (integer GB/days within provider limits are enforced by validateProductInput) and use one of the bot's fixed
 * subscription durations, and must not duplicate another sellable product's duration + traffic.
 */
function assertSupportedDuration(days) {
  if (!SUBSCRIPTION_DURATIONS.includes(Number(days))) {
    throw badProduct(`مدت اشتراک باید یکی از ${SUBSCRIPTION_DURATIONS.join("، ")} روز باشد.`, "unsupported_duration");
  }
}

async function assertSellable(candidate, { selfId = null } = {}) {
  assertSupportedDuration(candidate.durationDays);
  if (isUnlimitedTraffic(candidate.trafficGb)) {
    // A known no stops here. Not knowing does not: the checkout hides the product until the provider confirms it anyway.
    const account = await getProviderAccount();
    if (account && !account.limits.unlimitedEnabled) {
      throw badProduct("سرویس نامحدود برای این حساب WizardXray فعال نیست.", "unlimited_not_enabled", 409);
    }
  }
  const clash = await AdminProduct.findOne({
    durationDays: candidate.durationDays,
    trafficGb: candidate.trafficGb,
    enabled: true,
    archivedAt: null,
    ...(selfId ? { productId: { $ne: selfId } } : {}),
  }).select("productId name").lean();
  if (clash) {
    throw badProduct("محصول فعال دیگری با همین مدت و حجم وجود دارد.", "duplicate_product_definition", 409, { conflictsWith: clash.productId });
  }
}

function sameOperationApplied(product, operationId) {
  return Boolean(product && operationId && product.lastOperationId === operationId);
}

/**
 * Compare-and-set write. The revision read here (or supplied by the admin's stale form) must still be current;
 * otherwise nothing is written and the caller gets a 409 so the form can be refreshed.
 */
async function writeProduct({ id, current, expectedRevision, set = {}, unset = null, operationId, actorId }) {
  const revision = Number(current.revision || 0);
  const basis = expectedRevision ?? revision;
  const revisionFilter = basis === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision: basis };
  if (expectedRevision != null && expectedRevision !== revision) {
    throw badProduct("این محصول پس از باز کردن فرم تغییر کرده است؛ صفحه را تازه‌سازی کنید.", "product_stale", 409, { currentRevision: revision });
  }
  const update = {
    $set: { ...set, updatedBy: String(actorId), updatedAt: new Date(), lastOperationId: operationId },
    $inc: { revision: 1 },
    ...(unset ? { $unset: unset } : {}),
  };
  const written = await AdminProduct.findOneAndUpdate({ productId: id, ...revisionFilter }, update, { new: true, runValidators: true }).lean();
  if (!written) throw badProduct("این محصول هم‌زمان توسط مدیر دیگری تغییر کرد؛ صفحه را تازه‌سازی کنید.", "product_stale", 409);
  return written;
}

async function loadProduct(id) {
  const product = await AdminProduct.findOne({ productId: id }).lean();
  if (!product) throw badProduct("محصول یافت نشد.", "product_not_found", 404);
  return product;
}

export async function listProducts({ actorId, includeDisabled = true } = {}) {
  assertAdminUser(actorId);
  const query = includeDisabled ? {} : { enabled: true, archivedAt: null };
  const products = await AdminProduct.find(query).sort({ displayOrder: 1, productId: 1 }).lean();
  return products.map((product) => present(product));
}

function statusQuery(status) {
  switch (status) {
    case "live": return { enabled: true, published: { $ne: false }, archivedAt: null };
    case "disabled": return { enabled: false, archivedAt: null };
    case "hidden": return { enabled: true, published: false, archivedAt: null };
    case "archived": return { archivedAt: { $ne: null, $exists: true } };
    case "all": return {};
    default: return { archivedAt: null };
  }
}

async function referenceCounts(ids) {
  if (!ids.length) return new Map();
  const rows = await WalletPurchase.aggregate([{ $match: { planId: { $in: ids } } }, { $group: { _id: "$planId", n: { $sum: 1 } } }]);
  return new Map(rows.map((row) => [row._id, row.n]));
}

/** Server-side paginated, filtered and sorted catalog listing for the admin panel. */
export async function listProductsPage({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  const { page, pageSize } = parsePagination(query);
  const status = PRODUCT_STATUS_FILTERS.includes(query.status) ? query.status : "current";
  const sortField = Object.hasOwn(PRODUCT_SORT_FIELDS, query.sort) ? query.sort : "order";
  const direction = query.order === "desc" ? -1 : 1;
  const filter = statusQuery(status);
  const search = String(query.search ?? "").trim().slice(0, 80);
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    filter.$and = [{ $or: [{ name: pattern }, { productId: pattern }] }];
  }
  const duration = Number(query.duration);
  if (Number.isSafeInteger(duration) && duration > 0) filter.durationDays = duration;

  const sort = { [PRODUCT_SORT_FIELDS[sortField]]: direction, productId: 1 };
  const [items, filteredTotal, total] = await Promise.all([
    AdminProduct.find(filter).sort(sort).skip((page - 1) * pageSize).limit(pageSize).lean(),
    AdminProduct.countDocuments(filter),
    AdminProduct.estimatedDocumentCount(),
  ]);
  const references = await referenceCounts(items.map((item) => item.productId));
  return {
    items: items.map((item) => present(item, { references: references.get(item.productId) || 0 })),
    page,
    pageSize,
    total,
    filteredTotal,
    pages: Math.max(1, Math.ceil(filteredTotal / pageSize)),
  };
}

export async function createProduct({ actorId, operationId, input, ipAddress } = {}) {
  assertAdminUser(actorId);
  const values = validateProductInput(input);
  let customId = null;
  if (input.productId != null && input.productId !== "") {
    customId = String(input.productId);
    if (!CUSTOM_ID_PATTERN.test(customId)) throw badProduct("شناسه باید با حرف کوچک انگلیسی شروع شود و ۳ تا ۳۲ نویسه (a-z، 0-9، _) باشد.", "invalid_product_id");
  }
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PRODUCT_CREATED",
    targetType: "product",
    ipAddress,
    metadata: { name: values.name, durationDays: values.durationDays, trafficGb: values.trafficGb, priceToman: values.priceToman, costToman: values.costToman, enabled: values.enabled, published: values.published },
    resumeStarted: true,
    execute: async () => {
      let product = await AdminProduct.findOne({ createdByOperationId: operationId }).lean();
      if (!product) {
        if (customId && (isShippedPlanId(customId) || await AdminProduct.exists({ productId: customId }))) {
          throw badProduct("این شناسه قبلاً استفاده شده است.", "duplicate_product_id", 409);
        }
        assertSupportedDuration(values.durationDays);
        if (values.enabled) await assertSellable(values);
        try {
          product = await AdminProduct.create({
            productId: customId || newProductId(),
            ...values,
            revision: 0,
            lastOperationId: operationId,
            createdByOperationId: operationId,
            createdBy: String(actorId),
            updatedBy: String(actorId),
          });
        } catch (error) {
          if (error?.code === 11000) throw badProduct("این شناسه قبلاً استفاده شده است.", "duplicate_product_id", 409);
          throw error;
        }
      }
      return { product: present(product), auditSummary: { productId: product.productId } };
    },
  });
  return result;
}

/**
 * Edit any subset of fields. Availability-only changes are audited as PRODUCT_AVAILABILITY_CHANGED. Existing orders and
 * provisioned services keep the terms they were sold with: purchases snapshot plan name, volume, days and amount.
 */
export async function updateProduct({ actorId, operationId, productId, input, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = requireProductId(productId);
  const values = validateProductInput(input, { partial: true });
  const expectedRevision = parseExpectedRevision(input);
  if (!Object.keys(values).length) throw badProduct("هیچ فیلدی برای ویرایش محصول ارسال نشد.", "empty_product_update");
  const availabilityOnly = Object.keys(values).every((key) => key === "enabled" || key === "published");
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: availabilityOnly ? "PRODUCT_AVAILABILITY_CHANGED" : "PRODUCT_UPDATED",
    targetType: "product",
    targetId: id,
    ipAddress,
    metadata: values,
    resumeStarted: true,
    execute: async () => {
      const current = await loadProduct(id);
      if (sameOperationApplied(current, operationId)) return { product: present(current), auditSummary: { productId: id, fields: Object.keys(values) } };
      if (current.archivedAt) throw badProduct("محصول بایگانی‌شده را ابتدا بازیابی کنید.", "product_archived", 409);
      if (Object.hasOwn(values, "durationDays") && values.durationDays !== current.durationDays) assertSupportedDuration(values.durationDays);
      const merged = { ...current, ...values };
      // Rules apply whenever the result is purchasable; disabling an out-of-policy legacy row stays possible.
      if (merged.enabled) await assertSellable(merged, { selfId: id });
      const product = await writeProduct({ id, current, expectedRevision, set: values, operationId, actorId });
      return { product: present(product), auditSummary: { productId: id, fields: Object.keys(values) } };
    },
  });
  return result;
}

export async function duplicateProduct({ actorId, operationId, productId, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = requireProductId(productId);
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PRODUCT_CREATED",
    targetType: "product",
    targetId: id,
    ipAddress,
    metadata: { duplicateOf: id },
    resumeStarted: true,
    execute: async () => {
      let product = await AdminProduct.findOne({ createdByOperationId: operationId }).lean();
      if (!product) {
        const source = await loadProduct(id);
        product = await AdminProduct.create({
          productId: newProductId(),
          name: `${source.name} (copy)`.slice(0, 120),
          durationDays: source.durationDays,
          trafficGb: source.trafficGb,
          priceToman: source.priceToman,
          costToman: source.costToman,
          enabled: false,
          published: false,
          displayOrder: source.displayOrder + 1,
          revision: 0,
          lastOperationId: operationId,
          createdByOperationId: operationId,
          createdBy: String(actorId),
          updatedBy: String(actorId),
        });
      }
      return { product: present(product), auditSummary: { productId: product.productId, duplicateOf: id } };
    },
  });
  return result;
}

export async function reorderProducts({ actorId, operationId, productIds, ipAddress } = {}) {
  assertAdminUser(actorId);
  if (!Array.isArray(productIds) || productIds.length < 1 || productIds.length > 200 || productIds.some((id) => typeof id !== "string" || !PRODUCT_ID_PATTERN.test(id))) {
    throw badProduct("فهرستی از ۱ تا ۲۰۰ شناسه محصول لازم است.", "invalid_product_order");
  }
  if (new Set(productIds).size !== productIds.length) throw badProduct("ترتیب محصولات شامل شناسه تکراری است.", "duplicate_product_id");
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PRODUCT_UPDATED",
    targetType: "catalog",
    targetId: "display-order",
    ipAddress,
    metadata: { count: productIds.length },
    resumeStarted: true,
    execute: async () => {
      const operations = productIds.map((id, displayOrder) => ({ updateOne: { filter: { productId: id }, update: { $set: { displayOrder, updatedBy: String(actorId), updatedAt: new Date() }, $inc: { revision: 1 } } } }));
      const write = await AdminProduct.bulkWrite(operations, { ordered: true });
      if ((write.matchedCount ?? write.nMatched) !== productIds.length) throw badProduct("یک یا چند محصول دیگر وجود ندارد.", "product_order_conflict", 409);
      return { ok: true, updated: productIds.length, auditSummary: { updated: productIds.length } };
    },
  });
  return result;
}

/** Swap a product with its neighbour in the global display order (works across pages and re-normalizes ties). */
export async function moveProduct({ actorId, operationId, productId, direction, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = requireProductId(productId);
  if (direction !== "up" && direction !== "down") throw badProduct("جهت جابه‌جایی نامعتبر است.", "invalid_move_direction");
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PRODUCT_UPDATED",
    targetType: "catalog",
    targetId: "display-order",
    ipAddress,
    metadata: { moved: id, direction },
    resumeStarted: true,
    execute: async () => {
      const ordered = await AdminProduct.find({ archivedAt: null }).sort({ displayOrder: 1, productId: 1 }).select("productId").limit(MAX_REORDER_SCOPE).lean();
      const ids = ordered.map((row) => row.productId);
      const index = ids.indexOf(id);
      if (index === -1) throw badProduct("محصول فعال یافت نشد.", "product_not_found", 404);
      const target = direction === "up" ? index - 1 : index + 1;
      if (target >= 0 && target < ids.length) {
        [ids[index], ids[target]] = [ids[target], ids[index]];
        await AdminProduct.bulkWrite(ids.map((pid, displayOrder) => ({ updateOne: { filter: { productId: pid, displayOrder: { $ne: displayOrder } }, update: { $set: { displayOrder, updatedBy: String(actorId), updatedAt: new Date() }, $inc: { revision: 1 } } } })), { ordered: true });
      }
      return { ok: true, auditSummary: { productId: id, direction } };
    },
  });
  return result;
}

export async function setProductEnabled({ actorId, operationId, productId, enabled, expectedRevision, ipAddress } = {}) {
  if (typeof enabled !== "boolean") throw badProduct("وضعیت فعال یا غیرفعال را انتخاب کنید.", "invalid_product_enabled");
  return updateProduct({ actorId, operationId, productId, input: { enabled, ...(expectedRevision == null ? {} : { expectedRevision }) }, ipAddress });
}

export async function setProductPublished({ actorId, operationId, productId, published, expectedRevision, ipAddress } = {}) {
  if (typeof published !== "boolean") throw badProduct("وضعیت انتشار در فروشگاه باید مشخص باشد.", "invalid_product_published");
  return updateProduct({ actorId, operationId, productId, input: { published, ...(expectedRevision == null ? {} : { expectedRevision }) }, ipAddress });
}

/**
 * Soft-remove: the product stops being sellable and disappears from default lists, but keeps its id so historical
 * orders and already-provisioned services stay resolvable. Existing customers' VPN access is untouched.
 */
export async function archiveProduct({ actorId, operationId, productId, expectedRevision = null, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = requireProductId(productId);
  const revision = parseExpectedRevision({ expectedRevision });
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PRODUCT_ARCHIVED",
    targetType: "product",
    targetId: id,
    ipAddress,
    resumeStarted: true,
    execute: async () => {
      const current = await loadProduct(id);
      if (sameOperationApplied(current, operationId)) return { product: present(current), auditSummary: { productId: id } };
      if (current.archivedAt) throw badProduct("این محصول قبلاً بایگانی شده است.", "product_archived", 409);
      const product = await writeProduct({
        id, current, expectedRevision: revision, operationId, actorId,
        set: { enabled: false, published: false, archivedAt: new Date(), archivedBy: String(actorId) },
      });
      return { product: present(product), auditSummary: { productId: id } };
    },
  });
  return result;
}

/** Bring an archived product back as disabled and unpublished; the admin re-enables it explicitly. */
export async function restoreProduct({ actorId, operationId, productId, expectedRevision = null, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = requireProductId(productId);
  const revision = parseExpectedRevision({ expectedRevision });
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PRODUCT_RESTORED",
    targetType: "product",
    targetId: id,
    ipAddress,
    resumeStarted: true,
    execute: async () => {
      const current = await loadProduct(id);
      if (sameOperationApplied(current, operationId)) return { product: present(current), auditSummary: { productId: id } };
      if (!current.archivedAt) throw badProduct("این محصول بایگانی نشده است.", "product_not_archived", 409);
      const product = await writeProduct({
        id, current, expectedRevision: revision, operationId, actorId,
        set: { enabled: false, published: false, archivedAt: null, archivedBy: null },
      });
      return { product: present(product), auditSummary: { productId: id } };
    },
  });
  return result;
}

/** Everything that may still point at this product id: orders, crypto invoices and provisioned services. */
export async function countProductReferences(productId) {
  const [purchases, invoices, services] = await Promise.all([
    WalletPurchase.countDocuments({ planId: productId }),
    NowPaymentsInvoice.countDocuments({ planId: productId }),
    User.countDocuments({ "services.productId": productId }),
  ]);
  return { purchases, invoices, services, total: purchases + invoices + services };
}

/**
 * Permanent removal is allowed only for products that nothing refers to and that are not part of the shipped
 * catalog (those would be re-seeded). Everything else must be archived instead.
 *
 * Race safety (handshake with purchasePlan): (1) lock the product atomically, which makes every purchase lookup
 * refuse it; (2) count references; (3) delete only while the same lock is still held. A purchase that created its
 * order record before step 2 is counted and blocks the delete; one that creates it after step 2 re-checks the
 * product (isProductReferencable) after the record exists, sees the lock or the missing row, and withdraws the order.
 */
export async function deleteProduct({ actorId, operationId, productId, expectedRevision = null, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = requireProductId(productId);
  const revision = parseExpectedRevision({ expectedRevision });
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PRODUCT_DELETED",
    targetType: "product",
    targetId: id,
    ipAddress,
    resumeStarted: true,
    execute: async () => {
      const current = await AdminProduct.findOne({ productId: id }).lean();
      if (!current) return { ok: true, deleted: true, auditSummary: { productId: id, alreadyAbsent: true } };
      if (isShippedPlanId(id)) throw badProduct("پلن‌های پیش‌فرض قابل حذف دائمی نیستند؛ آن‌ها را بایگانی کنید.", "product_protected", 409);
      const currentRevision = Number(current.revision || 0);
      if (revision != null && revision !== currentRevision) throw badProduct("این محصول پس از باز کردن فرم تغییر کرده است؛ صفحه را تازه‌سازی کنید.", "product_stale", 409);
      const revisionFilter = currentRevision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision: currentRevision };

      const lockedAt = new Date();
      const staleBefore = new Date(lockedAt.getTime() - DELETE_LOCK_MS);
      const locked = await AdminProduct.findOneAndUpdate(
        { $and: [{ productId: id }, revisionFilter, { $or: [{ deleteLockedAt: { $exists: false } }, { deleteLockedAt: null }, { deleteLockedAt: { $lt: staleBefore } }] }] },
        { $set: { deleteLockedAt: lockedAt } },
        { new: true },
      ).lean();
      if (!locked) throw badProduct("این محصول هم‌زمان تغییر کرد یا حذف آن در حال انجام است؛ صفحه را تازه‌سازی کنید.", "product_stale", 409);

      const unlock = () => AdminProduct.updateOne({ productId: id, deleteLockedAt: lockedAt }, { $unset: { deleteLockedAt: "" } }).catch(() => {});
      try {
        const references = await countProductReferences(id);
        if (references.total > 0) {
          throw badProduct("این محصول در سفارش‌ها یا سرویس‌های موجود استفاده شده است؛ به‌جای حذف، آن را بایگانی کنید.", "product_in_use", 409, references);
        }
        const removed = await AdminProduct.deleteOne({ productId: id, deleteLockedAt: lockedAt, ...revisionFilter });
        if (!removed.deletedCount) throw badProduct("این محصول هم‌زمان تغییر کرد؛ صفحه را تازه‌سازی کنید.", "product_stale", 409);
      } catch (error) {
        await unlock();
        throw error;
      }
      return { ok: true, deleted: true, auditSummary: { productId: id } };
    },
  });
  return result;
}

export { validateProductInput, present as presentProduct };
