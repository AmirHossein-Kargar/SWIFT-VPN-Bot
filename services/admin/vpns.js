import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { findService, changeLinkService, deactiveService, deleteService, upgradeServiceTime, upgradeServiceSize, listClients } from "../../api/wizardApi.js";
import { acquireRedisLease, releaseRedisLease } from "../redisLease.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { escapeRegex, parsePagination, parsePositiveInteger, requireReason, requireServiceUsername } from "./validation.js";

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
  if (!user) throw new AdminServiceError("سرویس VPN در فهرست کاربران یافت نشد.", { status: 404, code: "service_not_found" });
  const service = (user.services || []).find((item) => item.username === username);
  if (!service) throw new AdminServiceError("سرویس VPN در فهرست کاربران یافت نشد.", { status: 404, code: "service_not_found" });
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
      extendTime: Boolean(panel),
      increaseTraffic: Boolean(panel),
      regenerateConfig: false,
    },
    unavailableActions: {
      regenerateConfig: "WizardXray integration has no regenerate-config endpoint.",
    },
  };
}

export async function performVpnAction({ actorId, operationId, username, action, reason, ipAddress, bot, days, gig } = {}) {
  assertAdminUser(actorId);
  const clientId = requireServiceUsername(username);
  if (!SUPPORTED_ACTIONS.has(action)) throw new AdminServiceError("عملیات پشتیبانی نشده است.", { status: 400, code: "invalid_vpn_action" });
  if (["revoke", "disable", "extend-time", "increase-traffic"].includes(action) && !reason) throw new AdminServiceError("دلیل انجام عملیات الزامی است.", { status: 400, code: "confirmation_required" });
  const safeReason = reason ? requireReason(reason) : null;
  // Amounts are validated before anything is audited or sent to the panel.
  let extendDays = null;
  let addGig = null;
  if (action === "extend-time") extendDays = parsePositiveInteger(days, { name: "days", min: 1, max: 3650 });
  if (action === "increase-traffic") {
    addGig = Number(gig);
    if (!Number.isFinite(addGig) || addGig < 0.5 || addGig > 100_000 || Math.round(addGig * 100) / 100 !== addGig) {
      throw new AdminServiceError("مقدار حجم باید حداقل ۰٫۵ گیگابایت (حداکثر دو رقم اعشار) باشد.", { status: 400, code: "invalid_gig" });
    }
  }
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
    metadata: { reason: safeReason, ...(extendDays ? { days: extendDays } : {}), ...(addGig ? { gig: addGig } : {}) },
    execute: async () => {
      if (action === "regenerate-config") {
        throw new AdminServiceError("این عملیات در دسترس نیست: API نسخهٔ ۱ ویزاردایکس چنین متدی ندارد (برای لینک جدید از «تغییر لینک» استفاده کنید).", { status: 501, code: "wizard_action_unavailable" });
      }
      const owner = await getOwner(clientId);
      let lease;
      try {
        lease = await acquireRedisLease(`admin:vpn:${clientId}`, 120);
        if (!lease) throw new AdminServiceError("عملیات دیگری روی این VPN در حال انجام است.", { status: 409, code: "vpn_action_in_progress" });
        if (action === "change-link") {
          const response = await changeLinkService(clientId);
          const link = response?.result?.new_sub_link;
          if (typeof link !== "string" || link.length > 4096 || !/^https:\/\//i.test(link)) {
            throw new AdminServiceError("WizardXray لینک جایگزین معتبری برنگرداند.", { status: 502, code: "wizard_invalid_response" });
          }
          await User.updateOne({ telegramId: String(owner.user.telegramId), "services.username": clientId }, { $set: { "services.$.sub_link": link } });
          if (owner.purchase?._id) await WalletPurchase.updateOne({ _id: owner.purchase._id }, { $set: { serviceLink: link } });
          return { ok: true, changed: true, auditSummary: { changed: true } };
        }
        if (action === "extend-time" || action === "increase-traffic") {
          const before = await findService(clientId);
          const beforeInfo = before?.result?.latest_info || {};
          if (!before?.result || typeof before.result !== "object") throw new AdminServiceError("سرویس در WizardXray پیدا نشد؛ تغییری اعمال نشد.", { status: 404, code: "wizard_service_not_found" });
          if (action === "extend-time") await upgradeServiceTime(clientId, extendDays);
          else await upgradeServiceSize(clientId, addGig);
          // Re-read the service: success is only declared when the panel shows the change.
          let after = null;
          try { after = (await findService(clientId))?.result?.latest_info || null; } catch { after = null; }
          let verified = null;
          if (action === "extend-time" && typeof beforeInfo.expire_date === "string" && typeof after?.expire_date === "string") {
            verified = after.expire_date !== beforeInfo.expire_date;
          }
          if (action === "increase-traffic" && Number.isFinite(Number(beforeInfo.gig)) && Number.isFinite(Number(after?.gig))) {
            verified = Number(after.gig) + 1e-6 >= Number(beforeInfo.gig) + addGig;
          }
          if (verified === false) {
            throw new AdminServiceError("WizardXray تغییر را در سرویس نشان نداد؛ پیش از تلاش دوباره وضعیت را در پنل بررسی کنید.", { status: 502, code: "wizard_change_not_confirmed" });
          }
          // Remote success is authoritative. Local copies are best-effort; a failure is reported, never hidden.
          let localSynced = true;
          try {
            if (action === "extend-time") {
              const base = owner.service.expiresAt || owner.purchase?.expiresAt;
              if (base) {
                const next = new Date(new Date(base).getTime() + extendDays * DAY_MS);
                await User.updateOne({ telegramId: String(owner.user.telegramId), "services.username": clientId }, { $set: { "services.$.expiresAt": next } });
                if (owner.purchase?._id) await WalletPurchase.updateOne({ _id: owner.purchase._id }, { $set: { expiresAt: next } });
              } else localSynced = false;
            } else if (Number.isFinite(Number(owner.service.trafficGb))) {
              await User.updateOne({ telegramId: String(owner.user.telegramId), "services.username": clientId }, { $inc: { "services.$.trafficGb": addGig } });
            } else localSynced = false;
          } catch { localSynced = false; }
          return {
            ok: true,
            changed: true,
            verified: verified === true,
            localSynced,
            panelExpiry: typeof after?.expire_date === "string" ? after.expire_date.slice(0, 80) : null,
            panelGig: Number.isFinite(Number(after?.gig)) ? Number(after.gig) : null,
            auditSummary: { changed: true, verified: verified === true, localSynced, ...(extendDays ? { days: extendDays } : { gig: addGig }) },
          };
        }
        if (action === "disable") {
          const current = await findService(clientId);
          const mode = current?.result?.online_info?.status;
          if (mode === "disabled" || mode === "inactive") return { ok: true, alreadyDisabled: true, auditSummary: { alreadyDisabled: true } };
          if (mode !== "active") throw new AdminServiceError("وضعیت فعلی در WizardXray مشخص نیست؛ تغییری اعمال نشد.", { status: 409, code: "wizard_state_unknown" });
          const response = await deactiveService(clientId);
          let newMode = response?.result?.new_mode;
          if (!newMode) {
            const confirmed = await findService(clientId);
            newMode = confirmed?.result?.online_info?.status;
          }
          if (!["disabled", "inactive"].includes(newMode)) throw new AdminServiceError("WizardXray وضعیت غیرفعال درخواستی را تأیید نکرد.", { status: 502, code: "wizard_state_not_confirmed" });
          return { ok: true, disabled: true, auditSummary: { disabled: true } };
        }
        if (action === "revoke") {
          const response = await deleteService(clientId);
          if (response?.ok !== true) throw new AdminServiceError("WizardXray حذف VPN را تأیید نکرد.", { status: 502, code: "wizard_revoke_not_confirmed" });
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
        throw new AdminServiceError("عملیات پشتیبانی نشده است.", { status: 400, code: "invalid_vpn_action" });
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

/**
 * Live services created through the API key (documented `clients` method),
 * cross-checked against local user records so unknown/orphan services are visible.
 */
export async function listRemoteClients({ actorId, limit = 100 } = {}) {
  assertAdminUser(actorId);
  const cap = Math.min(500, Math.max(1, Number.isSafeInteger(Number(limit)) ? Number(limit) : 100));
  let response;
  try { response = await listClients(cap); }
  catch (error) { throw new AdminServiceError(safeWizardError(error), { status: error?.ambiguous ? 503 : 502, code: error?.code || "wizard_api_failed" }); }
  const raw = Array.isArray(response?.result) ? response.result : Object.values(response?.result || {});
  const SENSITIVE = /link|hash|token|key|pass|secret|uuid/i;
  const items = raw.filter((row) => row && typeof row === "object").slice(0, cap).map((row) => {
    const safe = {};
    for (const [key, value] of Object.entries(row)) {
      if (SENSITIVE.test(key) || !["string", "number", "boolean"].includes(typeof value)) continue;
      safe[key] = typeof value === "string" ? value.slice(0, 120) : value;
    }
    return safe;
  });
  const names = items.map((row) => row.username).filter((name) => typeof name === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(name));
  const known = names.length ? await User.find({ "services.username": { $in: names } }).select("services.username").lean() : [];
  const knownSet = new Set(known.flatMap((user) => (user.services || []).map((service) => service.username)));
  return { source: "wizardxray", fetchedAt: new Date().toISOString(), count: items.length, items: items.map((row) => ({ ...row, knownLocally: knownSet.has(row.username) })) };
}

export const isSafeWizardError = (error) => safeWizardError(error);
