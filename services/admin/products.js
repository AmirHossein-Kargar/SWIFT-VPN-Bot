import { randomUUID } from "node:crypto";
import AdminProduct from "../../models/AdminProduct.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { parsePositiveInteger } from "./validation.js";

function validateProductInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminServiceError("Product data is required.", { status: 400, code: "invalid_product" });
  const output = {};
  if (!partial || Object.hasOwn(input, "name")) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new AdminServiceError("Product name must contain 1 to 120 printable characters.", { status: 400, code: "invalid_product_name" });
    output.name = name;
  }
  if (!partial || Object.hasOwn(input, "durationDays")) output.durationDays = parsePositiveInteger(input.durationDays, { name: "duration days", min: 1, max: 3650 });
  if (!partial || Object.hasOwn(input, "trafficGb")) output.trafficGb = parsePositiveInteger(input.trafficGb, { name: "traffic GB", min: 1, max: 100_000 });
  if (!partial || Object.hasOwn(input, "priceToman")) output.priceToman = parsePositiveInteger(input.priceToman, { name: "price", min: 1, max: 2_000_000_000 });
  if (!partial || Object.hasOwn(input, "costToman")) output.costToman = parsePositiveInteger(input.costToman, { name: "cost", min: 0, max: 2_000_000_000 });
  if (!partial || Object.hasOwn(input, "enabled")) {
    if (typeof input.enabled !== "boolean") throw new AdminServiceError("Product enabled must be true or false.", { status: 400, code: "invalid_product_enabled" });
    output.enabled = input.enabled;
  }
  if (!partial || Object.hasOwn(input, "displayOrder")) output.displayOrder = parsePositiveInteger(input.displayOrder ?? 0, { name: "display order", min: 0, max: 100_000 });
  return output;
}

function present(product) {
  const item = product?.toObject ? product.toObject() : product;
  return {
    id: String(item.productId),
    name: item.name,
    durationDays: Number(item.durationDays),
    trafficGb: Number(item.trafficGb),
    priceToman: Number(item.priceToman),
    costToman: Number(item.costToman),
    profitToman: Number(item.priceToman) - Number(item.costToman),
    enabled: Boolean(item.enabled),
    displayOrder: Number(item.displayOrder || 0),
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

export async function listProducts({ actorId, includeDisabled = true } = {}) {
  assertAdminUser(actorId);
  const query = includeDisabled ? {} : { enabled: true };
  const products = await AdminProduct.find(query).sort({ displayOrder: 1, productId: 1 }).lean();
  return products.map(present);
}

export async function createProduct({ actorId, operationId, input, ipAddress } = {}) {
  assertAdminUser(actorId);
  const values = validateProductInput(input);
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PRODUCT_CREATED",
    targetType: "product",
    ipAddress,
    metadata: { name: values.name, durationDays: values.durationDays, trafficGb: values.trafficGb, priceToman: values.priceToman, costToman: values.costToman },
    resumeStarted: true,
    execute: async () => {
      let product = await AdminProduct.findOne({ createdByOperationId: operationId }).lean();
      if (!product) {
        product = await AdminProduct.create({
          productId: `PRD-${randomUUID()}`,
          ...values,
          createdByOperationId: operationId,
          createdBy: String(actorId),
          updatedBy: String(actorId),
        });
      }
      return { product: present(product), auditSummary: { productId: product.productId } };
    },
  });
  return result;
}

export async function updateProduct({ actorId, operationId, productId, input, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = String(productId ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AdminServiceError("Invalid product ID.", { status: 400, code: "invalid_product_id" });
  const values = validateProductInput(input, { partial: true });
  if (!Object.keys(values).length) throw new AdminServiceError("No product fields were supplied.", { status: 400, code: "empty_product_update" });
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "PRODUCT_UPDATED",
    targetType: "product",
    targetId: id,
    ipAddress,
    metadata: values,
    resumeStarted: true,
    execute: async () => {
      const product = await AdminProduct.findOneAndUpdate(
        { productId: id },
        { $set: { ...values, updatedBy: String(actorId), updatedAt: new Date() } },
        { new: true, runValidators: true }
      ).lean();
      if (!product) throw new AdminServiceError("Product not found.", { status: 404, code: "product_not_found" });
      return { product: present(product), auditSummary: { productId: id, fields: Object.keys(values) } };
    },
  });
  return result;
}

export async function duplicateProduct({ actorId, operationId, productId, ipAddress } = {}) {
  assertAdminUser(actorId);
  const id = String(productId ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AdminServiceError("Invalid product ID.", { status: 400, code: "invalid_product_id" });
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
        const source = await AdminProduct.findOne({ productId: id }).lean();
        if (!source) throw new AdminServiceError("Product not found.", { status: 404, code: "product_not_found" });
        product = await AdminProduct.create({
          productId: `PRD-${randomUUID()}`,
          name: `${source.name} (copy)`.slice(0, 120),
          durationDays: source.durationDays,
          trafficGb: source.trafficGb,
          priceToman: source.priceToman,
          costToman: source.costToman,
          enabled: false,
          displayOrder: source.displayOrder + 1,
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
  if (!Array.isArray(productIds) || productIds.length < 1 || productIds.length > 200 || productIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    throw new AdminServiceError("A list of 1 to 200 product IDs is required.", { status: 400, code: "invalid_product_order" });
  }
  if (new Set(productIds).size !== productIds.length) throw new AdminServiceError("Product order contains duplicates.", { status: 400, code: "duplicate_product_id" });
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
      const operations = productIds.map((id, displayOrder) => ({ updateOne: { filter: { productId: id }, update: { $set: { displayOrder, updatedBy: String(actorId), updatedAt: new Date() } } } }));
      const write = await AdminProduct.bulkWrite(operations, { ordered: true });
      if ((write.matchedCount ?? write.nMatched) !== productIds.length) throw new AdminServiceError("One or more products no longer exist.", { status: 409, code: "product_order_conflict" });
      return { ok: true, updated: productIds.length, auditSummary: { updated: productIds.length } };
    },
  });
  return result;
}

export async function setProductEnabled({ actorId, operationId, productId, enabled, ipAddress } = {}) {
  if (typeof enabled !== "boolean") throw new AdminServiceError("Choose enabled or disabled.", { status: 400, code: "invalid_product_enabled" });
  return updateProduct({ actorId, operationId, productId, input: { enabled }, ipAddress });
}

export { validateProductInput, present as presentProduct };
