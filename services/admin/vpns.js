import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { findService, changeLinkService, deactiveService, deleteService } from "../../api/wizardApi.js";
import { acquireRedisLease, releaseRedisLease } from "../redisLease.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { escapeRegex, parsePagination, requireReason, requireServiceUsername } from "./validation.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_ACTIONS = new Set(["change-link", "disable", "revoke", "extend-time", "increase-traffic", "regenerate-config"]);

function safeWizardError(error) {
  if (Number.isInteger(error?.status)) return `WizardXray returned HTTP ${error.status}.`;
  if (error?.code === "ETIMEDOUT" || error?.code === "ECONNABORTED") return "WizardXray request timed out.";
  if (error?.ambiguous) return "WizardXray outcome is uncertain; inspect the panel before retrying.";
  return "WizardXray could not complete the request.";
}

export async function listVpns({ actorId, query = {}, now = new Date() } = {}) {
  assertAdminUser(actorId);
  const { page, pageSize } = parsePagination(query);
  const pipeline = [
    { $match: { "services.0": { $exists: true } } },
    { $unwind: "$services" },
  ];
  const search = String(query.search ?? "").trim().slice(0, 100);
  if (search) {
    const regex = new RegExp(escapeRegex(search.replace(/^@/, "")), "i");
    const exact = new RegExp(`^${escapeRegex(search)}`, "i");
    pipeline.push({ $match: { $or: [
      { "services.username": exact }, { telegramId: search }, { username: regex }, { firstName: regex }, { lastName: regex },
    ] } });
  }
  pipeline.push({
    $lookup: {
      from: WalletPurchase.collection.name,
      let: { purchaseId: "$services.purchaseId", serviceUsername: "$services.username" },
      pipeline: [
        { $match: { $expr: { $or: [
          { $and: [{ $ne: ["$$purchaseId", null] }, { $eq: ["$purchaseId", "$$purchaseId"] }] },
          { $eq: ["$serviceUsername", "$$serviceUsername"] },
        ] } } },
        { $limit: 1 },
        { $project: { purchaseId: 1, planId: 1, planName: 1, gig: 1, days: 1, createdAt: 1, completedAt: 1, expiresAt: 1, status: 1, revokedAt: 1 } },
      ],
      as: "purchaseDoc",
    },
  });
  pipeline.push({ $addFields: { purchaseDoc: { $arrayElemAt: ["$purchaseDoc", 0] } } });
  pipeline.push({
    $addFields: {
      effectiveExpiry: {
        $ifNull: [
          "$services.expiresAt",
          { $ifNull: [
            "$purchaseDoc.expiresAt",
            { $cond: [
              { $and: [{ $ne: ["$purchaseDoc", null] }, { $gt: ["$purchaseDoc.days", 0] }] },
              { $add: [{ $ifNull: ["$purchaseDoc.completedAt", "$purchaseDoc.createdAt"] }, { $multiply: ["$purchaseDoc.days", DAY_MS] }] },
              null,
            ] },
          ] },
        ],
      },
      effectiveCreatedAt: { $ifNull: ["$services.createdAt", { $ifNull: ["$purchaseDoc.provisionedAt", "$purchaseDoc.createdAt"] }] },
      serviceRevokedAt: { $ifNull: ["$services.revokedAt", "$purchaseDoc.revokedAt"] },
      trafficGbValue: { $ifNull: ["$services.trafficGb", "$purchaseDoc.gig"] },
    },
  });
  const status = String(query.status || "all");
  if (status === "active") pipeline.push({ $match: { serviceRevokedAt: null, effectiveExpiry: { $gt: now } } });
  else if (status === "expired") pipeline.push({ $match: { serviceRevokedAt: null, effectiveExpiry: { $lte: now } } });
  else if (status === "expiring") pipeline.push({ $match: { serviceRevokedAt: null, effectiveExpiry: { $gt: now, $lte: new Date(now.getTime() + 7 * DAY_MS) } } });
  else if (status === "revoked") pipeline.push({ $match: { serviceRevokedAt: { $ne: null } } });
  else if (status === "unknown") pipeline.push({ $match: { effectiveExpiry: null, serviceRevokedAt: null } });

  const sort = query.sort === "expiry" ? { effectiveExpiry: 1, _id: 1 } : { effectiveCreatedAt: -1, _id: -1 };
  pipeline.push({ $sort: sort });
  pipeline.push({ $facet: {
    items: [
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      { $project: {
        _id: 0,
        telegramId: 1,
        username: "$username",
        firstName: 1,
        lastName: 1,
        clientId: "$services.username",
        purchaseId: { $ifNull: ["$services.purchaseId", "$purchaseDoc.purchaseId"] },
        productId: { $ifNull: ["$services.productId", "$purchaseDoc.planId"] },
        product: { $ifNull: ["$purchaseDoc.planName", "$purchaseDoc.planId"] },
        trafficGb: "$trafficGbValue",
        createdAt: "$effectiveCreatedAt",
        expiresAt: "$effectiveExpiry",
        revokedAt: "$serviceRevokedAt",
        status: { $cond: [{ $ne: ["$serviceRevokedAt", null] }, "revoked", { $cond: [{ $eq: ["$effectiveExpiry", null] }, "unknown", { $cond: [{ $lte: ["$effectiveExpiry", now] }, "expired", "active"] }] }] },
      } },
    ],
    total: [{ $count: "count" }],
  } });
  const [result] = await User.aggregate(pipeline).allowDiskUse(true).option({ maxTimeMS: 10_000 });
  const items = (result?.items || []).map((item) => ({
    ...item,
    telegramId: String(item.telegramId),
    ownerName: [item.firstName, item.lastName].filter(Boolean).join(" ") || null,
    trafficGb: Number.isFinite(Number(item.trafficGb)) ? Number(item.trafficGb) : null,
  }));
  return { items, page, pageSize, total: Number(result?.total?.[0]?.count || 0), pages: Math.ceil(Number(result?.total?.[0]?.count || 0) / pageSize) };
}

async function getOwner(username) {
  const user = await User.findOne({ "services.username": username }).select("telegramId username firstName lastName services").lean();
  if (!user) throw new AdminServiceError("VPN service was not found in the local user registry.", { status: 404, code: "service_not_found" });
  const service = (user.services || []).find((item) => item.username === username);
  if (!service) throw new AdminServiceError("VPN service was not found in the local user registry.", { status: 404, code: "service_not_found" });
  const purchase = service.purchaseId
    ? await WalletPurchase.findOne({ purchaseId: service.purchaseId }).lean()
    : await WalletPurchase.findOne({ serviceUsername: username }).lean();
  return { user, service, purchase };
}

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function getVpnDetail({ actorId, username } = {}) {
  assertAdminUser(actorId);
  const clientId = requireServiceUsername(username);
  const { user, service, purchase } = await getOwner(clientId);
  let panel = null;
  let panelError = null;
  let latencyMs = null;
  const startedAt = Date.now();
  try {
    const response = await findService(clientId);
    if (!response?.result || typeof response.result !== "object") throw new Error("PANEL_INVALID_RESULT");
    panel = response.result;
  } catch (error) {
    panelError = safeWizardError(error);
  } finally {
    latencyMs = Date.now() - startedAt;
  }
  const online = panel?.online_info || {};
  const latest = panel?.latest_info || {};
  const createdAt = service.createdAt || purchase?.provisionedAt || purchase?.completedAt || purchase?.createdAt || null;
  const expiresAt = service.expiresAt || purchase?.expiresAt || null;
  const maxGb = asFiniteNumber(latest.gig) ?? asFiniteNumber(service.trafficGb) ?? asFiniteNumber(purchase?.gig);
  const usedGb = asFiniteNumber(online.usage_gb);
  return {
    user: {
      telegramId: String(user.telegramId),
      username: user.username || null,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
      isBanned: Boolean(user.isBanned),
    },
    clientId,
    product: purchase?.planName || service.productId || purchase?.planId || null,
    productId: service.productId || purchase?.planId || null,
    createdAt,
    expiresAt,
    panelExpiry: typeof latest.expire_date === "string" ? latest.expire_date.slice(0, 80) : null,
    durationDays: Number(purchase?.days || 0) || null,
    trafficGb: maxGb,
    trafficUsed: typeof online.usage_converted === "string" ? online.usage_converted.slice(0, 80) : null,
    trafficRemainingGb: maxGb == null || usedGb == null ? null : Math.max(0, maxGb - usedGb),
    status: service.revokedAt || purchase?.revokedAt ? "revoked" : (online.status || (panelError ? "unknown" : "unknown")),
    wizardXray: { status: panel ? "connected" : "unavailable", latencyMs, error: panelError },
    wizardStatus: online.status || null,
    purchaseStatus: purchase?.status || null,
    availableActions: {
      changeLink: Boolean(panel),
      disable: Boolean(panel && online.status === "active"),
      revoke: Boolean(panel),
      extendTime: false,
      increaseTraffic: false,
      regenerateConfig: false,
    },
    unavailableActions: {
      extendTime: "WizardXray integration has no safe extend-time endpoint.",
      increaseTraffic: "WizardXray integration has no safe traffic-adjustment endpoint.",
      regenerateConfig: "WizardXray integration has no regenerate-config endpoint.",
    },
  };
}

export async function performVpnAction({ actorId, operationId, username, action, reason, ipAddress, bot } = {}) {
  assertAdminUser(actorId);
  const clientId = requireServiceUsername(username);
  if (!SUPPORTED_ACTIONS.has(action)) throw new AdminServiceError("Unsupported VPN action.", { status: 400, code: "invalid_vpn_action" });
  if (["revoke", "disable"].includes(action) && !reason) throw new AdminServiceError("A confirmation reason is required.", { status: 400, code: "confirmation_required" });
  const safeReason = reason ? requireReason(reason) : null;
  const actionNames = {
    "change-link": "VPN_LINK_CHANGED",
    disable: "VPN_DISABLED",
    revoke: "VPN_REVOKED",
    "extend-time": "VPN_EXTENDED",
    "increase-traffic": "VPN_TRAFFIC_ADDED",
    "regenerate-config": "VPN_REGENERATED",
  };
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: actionNames[action],
    targetType: "vpn",
    targetId: clientId,
    ipAddress,
    metadata: { reason: safeReason },
    execute: async () => {
      if (["extend-time", "increase-traffic", "regenerate-config"].includes(action)) {
        throw new AdminServiceError("This operation is unavailable: the configured WizardXray client has no safe endpoint for it.", { status: 501, code: "wizard_action_unavailable" });
      }
      const owner = await getOwner(clientId);
      let lease;
      try {
        lease = await acquireRedisLease(`admin:vpn:${clientId}`, 120);
        if (!lease) throw new AdminServiceError("Another operation on this VPN is still in progress.", { status: 409, code: "vpn_action_in_progress" });
        if (action === "change-link") {
          const response = await changeLinkService(clientId);
          const link = response?.result?.new_sub_link;
          if (typeof link !== "string" || link.length > 4096 || !/^https:\/\//i.test(link)) {
            throw new AdminServiceError("WizardXray did not return a valid replacement link.", { status: 502, code: "wizard_invalid_response" });
          }
          await User.updateOne({ telegramId: String(owner.user.telegramId), "services.username": clientId }, { $set: { "services.$.sub_link": link } });
          if (owner.purchase?._id) await WalletPurchase.updateOne({ _id: owner.purchase._id }, { $set: { serviceLink: link } });
          return { ok: true, changed: true, auditSummary: { changed: true } };
        }
        if (action === "disable") {
          const current = await findService(clientId);
          const mode = current?.result?.online_info?.status;
          if (mode === "disabled" || mode === "inactive") return { ok: true, alreadyDisabled: true, auditSummary: { alreadyDisabled: true } };
          if (mode !== "active") throw new AdminServiceError("Current WizardXray state is not clear; no toggle was applied.", { status: 409, code: "wizard_state_unknown" });
          const response = await deactiveService(clientId);
          let newMode = response?.result?.new_mode;
          if (!newMode) {
            const confirmed = await findService(clientId);
            newMode = confirmed?.result?.online_info?.status;
          }
          if (!["disabled", "inactive"].includes(newMode)) throw new AdminServiceError("WizardXray did not confirm the requested disabled state.", { status: 502, code: "wizard_state_not_confirmed" });
          return { ok: true, disabled: true, auditSummary: { disabled: true } };
        }
        if (action === "revoke") {
          const response = await deleteService(clientId);
          if (response?.ok !== true) throw new AdminServiceError("WizardXray did not confirm VPN revocation.", { status: 502, code: "wizard_revoke_not_confirmed" });
          await User.updateOne(
            { telegramId: String(owner.user.telegramId), "services.username": clientId },
            { $pull: { services: { username: clientId } } }
          );
          await User.updateOne({ telegramId: String(owner.user.telegramId) }, [{ $set: { totalServices: { $size: { $ifNull: ["$services", []] } } } }]);
          if (owner.purchase?._id) {
            await WalletPurchase.updateOne({ _id: owner.purchase._id }, { $set: { revokedAt: new Date(), revokedBy: String(actorId) } });
          }
          return { ok: true, revoked: true, auditSummary: { revoked: true } };
        }
        throw new AdminServiceError("Unsupported VPN action.", { status: 400, code: "invalid_vpn_action" });
      } catch (error) {
        if (error instanceof AdminServiceError) throw error;
        const safe = new AdminServiceError(safeWizardError(error), { status: error?.ambiguous ? 503 : 502, code: error?.code || "wizard_api_failed" });
        safe.ambiguous = Boolean(error?.ambiguous);
        throw safe;
      } finally {
        if (lease) await releaseRedisLease(lease).catch(() => {});
      }
    },
  });
  return result;
}

export const isSafeWizardError = (error) => safeWizardError(error);
