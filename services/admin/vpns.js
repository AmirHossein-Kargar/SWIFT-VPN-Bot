import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { getServiceInfo, changeLinkService, setServiceStatus, deleteService, upgradeServiceTime, upgradeServiceSize, renewService, listClients, getHosts, quotePrice, UNLIMITED_GIG } from "../../api/wizardApi.js";
import { acquireRedisLease, releaseRedisLease } from "../redisLease.js";
import { getProviderAccount, invalidateProviderAccount } from "../wizardAccount.js";
import { invalidateServiceStatus } from "../wizardServiceStatus.js";
import { persistNewLink } from "../manageServices/changeServiceLink.js";
import { recordServiceRemoval } from "../manageServices/deleteCustomerService.js";
import { isUnlimitedTraffic, volumeNumber } from "../../utils/serviceTerms.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { escapeRegex, parsePagination, parsePositiveInteger, requireReason, requireServiceUsername } from "./validation.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_ACTIONS = new Set(["change-link", "disable", "enable", "revoke", "extend-time", "increase-traffic", "renew", "regenerate-config"]);
const REASON_REQUIRED = new Set(["revoke", "disable", "enable", "extend-time", "increase-traffic", "renew"]);
const REMOTE_PAGE_MAX = 100;
const MATCH_PAGE = 200;
const MATCH_MAX_ROWS = 4_000;
const MATCH_EARLY_MS = 2 * 60_000;
const MATCH_LATE_MS = 15 * 60_000;

/** The specific reasons an admin can act on. Everything else is the general message below. */
const WIZARD_REASON_TEXT = {
  provider_insufficient_balance: "The WizardXray wallet is short of funds; nothing was charged.",
  provider_busy: "WizardXray is still working on this service; nothing was charged. Try again shortly.",
  service_not_found: "WizardXray does not have this service.",
  service_is_unlimited: "This service is unlimited, so traffic cannot be added.",
  unlimited_disabled: "Unlimited is switched off for this WizardXray account.",
  unlimited_days_out_of_range: "That is outside the days allowed for an unlimited service.",
  add_gig_below_minimum: "WizardXray adds at least 1 GB.",
  add_gig_above_maximum: "That is more traffic than WizardXray allows at once.",
  add_day_above_maximum: "That is more days than WizardXray allows at once.",
  terms_below_minimum: "Those terms are below the WizardXray minimum.",
  terms_above_maximum: "Those terms are above the WizardXray maximum.",
  update_failed: "WizardXray could not apply the change; any charge was returned.",
  panel_read_failed: "WizardXray could not read the service right now; nothing was charged.",
  delete_failed: "WizardXray could not delete the service; nothing changed.",
  auth_invalid: "WizardXray rejected the API key.",
  auth_missing: "WizardXray rejected the request: no API key was accepted.",
  api_disabled: "The WizardXray web service is switched off right now.",
};

function safeWizardError(error) {
  if (WIZARD_REASON_TEXT[error?.reason]) return WIZARD_REASON_TEXT[error.reason];
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
    trafficGb: asFiniteNumber(item.trafficGb),
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

/** Null stays null: a record with no volume (a test service) is not an unlimited one. */
function asFiniteNumber(value) {
  const number = volumeNumber(value);
  return Number.isFinite(number) ? number : null;
}

/** The provider's numbers beat our copy, and only a value it really sent replaces one. Best effort: a failure is reported. */
async function syncLocalService(owner, clientId, service) {
  const set = {};
  if (service.expiresAt) set["services.$.expiresAt"] = service.expiresAt;
  if (service.subLink) set["services.$.sub_link"] = service.subLink;
  if (service.unlimited) set["services.$.trafficGb"] = UNLIMITED_GIG;
  else if (service.dataLimitGb != null) set["services.$.trafficGb"] = service.dataLimitGb;
  if (!Object.keys(set).length) return false;
  await User.updateOne({ telegramId: String(owner.user.telegramId), "services.username": clientId }, { $set: set });
  if (owner.purchase?._id && service.expiresAt) await WalletPurchase.updateOne({ _id: owner.purchase._id }, { $set: { expiresAt: service.expiresAt } });
  return true;
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
    panel = await getServiceInfo(clientId);
  } catch (error) {
    panelError = safeWizardError(error);
  } finally {
    latencyMs = Date.now() - startedAt;
  }
  const createdAt = service.createdAt || purchase?.provisionedAt || purchase?.completedAt || purchase?.createdAt || null;
  const expiresAt = panel?.expiresAt || service.expiresAt || purchase?.expiresAt || null;
  const unlimited = panel ? panel.unlimited : isUnlimitedTraffic(service.trafficGb);
  const maxGb = unlimited ? UNLIMITED_GIG : panel?.dataLimitGb ?? asFiniteNumber(service.trafficGb) ?? asFiniteNumber(purchase?.gig);
  const live = panel?.live === true;
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
    panelExpiry: panel?.expireJalali ?? null,
    daysLeft: panel?.daysLeft ?? null,
    durationDays: Number(purchase?.days || 0) || null,
    unlimited,
    trafficGb: maxGb,
    trafficUsed: panel?.usedGb != null ? `${panel.usedGb} GB` : null,
    trafficRemainingGb: unlimited ? null : panel?.remainingGb ?? null,
    lastClient: panel?.lastClient ?? null,
    status: service.revokedAt || purchase?.revokedAt ? "revoked" : panel?.status || "unknown",
    wizardXray: { status: live ? "connected" : panel ? "stale" : "unavailable", latencyMs, error: panelError ?? (panel && !live ? "WizardXray answered from its stored copy: the service panel is not responding, so usage may be old." : null) },
    wizardStatus: panel?.status ?? null,
    purchaseStatus: purchase?.status || null,
    // A change needs the panel's live view of the service, so a stored copy reads only.
    availableActions: {
      changeLink: live,
      disable: live && panel.status === "active",
      enable: live && panel.status === "disabled",
      revoke: live,
      extendTime: live,
      increaseTraffic: live && !unlimited,
      renew: live,
      regenerateConfig: false,
    },
    unavailableActions: {
      regenerateConfig: "WizardXray integration has no regenerate-config endpoint.",
    },
  };
}

function parseGig(value, { min }) {
  const parsed = typeof value === "string" && value.trim() === "" ? Number.NaN : Number(value ?? Number.NaN);
  if (!Number.isFinite(parsed) || parsed < min || parsed > 10_000 || Math.round(parsed * 100) / 100 !== parsed) {
    throw new AdminServiceError(`مقدار حجم باید بین ${min} و ۱۰٬۰۰۰ گیگابایت (حداکثر دو رقم اعشار) باشد.`, { status: 400, code: "invalid_gig" });
  }
  return parsed;
}

export async function performVpnAction({ actorId, operationId, username, action, reason, ipAddress, days, gig, unlimited, leases = { acquire: acquireRedisLease, release: releaseRedisLease } } = {}) {
  assertAdminUser(actorId);
  const clientId = requireServiceUsername(username);
  if (!SUPPORTED_ACTIONS.has(action)) throw new AdminServiceError("عملیات پشتیبانی نشده است.", { status: 400, code: "invalid_vpn_action" });
  if (REASON_REQUIRED.has(action) && !reason) throw new AdminServiceError("دلیل انجام عملیات الزامی است.", { status: 400, code: "confirmation_required" });
  const safeReason = reason ? requireReason(reason) : null;
  // Amounts are validated before anything is audited or sent to the panel.
  let extendDays = null;
  let addGig = null;
  if (action === "extend-time" || action === "renew") extendDays = parsePositiveInteger(days, { name: "days", min: 1, max: 3650 });
  if (action === "increase-traffic") addGig = parseGig(gig, { min: 1 });
  // Renewing as unlimited is its own explicit choice: a blank or zero volume field must never select it.
  if (action === "renew") addGig = unlimited === true ? UNLIMITED_GIG : parseGig(gig, { min: 0.5 });
  const actionNames = {
    "change-link": "VPN_LINK_CHANGED",
    disable: "VPN_DISABLED",
    enable: "VPN_ENABLED",
    revoke: "VPN_REVOKED",
    "extend-time": "VPN_EXTENDED",
    "increase-traffic": "VPN_TRAFFIC_ADDED",
    renew: "VPN_RENEWED",
    "regenerate-config": "VPN_REGENERATED",
  };
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: actionNames[action],
    targetType: "vpn",
    targetId: clientId,
    ipAddress,
    metadata: { reason: safeReason, ...(extendDays ? { days: extendDays } : {}), ...(addGig != null ? { gig: addGig } : {}) },
    execute: async () => {
      if (action === "regenerate-config") {
        throw new AdminServiceError("این عملیات در دسترس نیست: API نسخهٔ ۱ ویزاردایکس چنین متدی ندارد (برای لینک جدید از «تغییر لینک» استفاده کنید).", { status: 501, code: "wizard_action_unavailable" });
      }
      const owner = await getOwner(clientId);
      let lease;
      try {
        lease = await leases.acquire(`admin:vpn:${clientId}`, 120);
        if (!lease) throw new AdminServiceError("عملیات دیگری روی این VPN در حال انجام است.", { status: 409, code: "vpn_action_in_progress" });
        if (action === "change-link") {
          const response = await changeLinkService(clientId);
          let localSynced = true;
          try {
            await persistNewLink({ telegramId: String(owner.user.telegramId), username: clientId, link: response.result.new_sub_link, hash: response.result.new_hash });
          } catch { localSynced = false; }
          return { ok: true, changed: true, localSynced, auditSummary: { changed: true, localSynced } };
        }
        if (action === "extend-time" || action === "increase-traffic" || action === "renew") {
          let before;
          try {
            before = await getServiceInfo(clientId);
          } catch (error) {
            if (error?.reason === "service_not_found") throw new AdminServiceError("سرویس در WizardXray پیدا نشد؛ تغییری اعمال نشد.", { status: 404, code: "wizard_service_not_found" });
            throw error;
          }
          if (action === "increase-traffic" && before.unlimited) throw new AdminServiceError(WIZARD_REASON_TEXT.service_is_unlimited, { status: 409, code: "wizard_service_unlimited" });
          let response;
          if (action === "extend-time") response = await upgradeServiceTime(clientId, extendDays);
          else if (action === "increase-traffic") response = await upgradeServiceSize(clientId, addGig);
          else response = await renewService(clientId, addGig, extendDays);
          invalidateProviderAccount();
          // These answers carry the service after the change. Without one, read it: success is declared only when the panel shows it.
          let after = response.service;
          if (!after) { try { after = await getServiceInfo(clientId); } catch { after = null; } }
          let verified = null;
          if (after) {
            if (action === "extend-time") verified = Boolean(after.expiresAt && (!before.expiresAt || after.expiresAt > before.expiresAt));
            else if (action === "increase-traffic") verified = (after.dataLimitGb ?? 0) + 1e-6 >= (before.dataLimitGb ?? 0) + addGig;
            else verified = addGig === UNLIMITED_GIG ? after.unlimited : !after.unlimited && (after.dataLimitGb ?? 0) + 1e-6 >= addGig;
          }
          if (verified === false) {
            throw new AdminServiceError("WizardXray تغییر را در سرویس نشان نداد؛ پیش از تلاش دوباره وضعیت را در پنل بررسی کنید.", { status: 502, code: "wizard_change_not_confirmed" });
          }
          // Remote success is authoritative. Local copies are best-effort; a failure is reported, never hidden.
          let localSynced = false;
          try { if (after) localSynced = await syncLocalService(owner, clientId, after); } catch { localSynced = false; }
          const summary = { changed: true, verified: verified === true, localSynced, ...(extendDays ? { days: extendDays } : {}), ...(addGig != null ? { gig: addGig } : {}), ...(Number.isFinite(response.result?.price) ? { price: response.result.price } : {}) };
          return {
            ok: true,
            changed: true,
            verified: verified === true,
            localSynced,
            unlimited: after?.unlimited ?? null,
            panelExpiry: after?.expireJalali ?? null,
            panelGig: after?.dataLimitGb ?? null,
            auditSummary: summary,
          };
        }
        if (action === "disable" || action === "enable") {
          const target = action === "disable" ? "disabled" : "active";
          const current = await getServiceInfo(clientId);
          if (current.status === target) return { ok: true, [action === "disable" ? "alreadyDisabled" : "alreadyEnabled"]: true, auditSummary: { unchanged: true } };
          if (!current.live || !["active", "disabled"].includes(current.status)) throw new AdminServiceError("وضعیت فعلی در WizardXray مشخص نیست؛ تغییری اعمال نشد.", { status: 409, code: "wizard_state_unknown" });
          const response = await setServiceStatus(clientId, target);
          if (response.service && response.service.status !== target) throw new AdminServiceError("WizardXray وضعیت درخواستی را تأیید نکرد.", { status: 502, code: "wizard_state_not_confirmed" });
          return { ok: true, [action === "disable" ? "disabled" : "enabled"]: true, auditSummary: { [action === "disable" ? "disabled" : "enabled"]: true } };
        }
        if (action === "revoke") {
          const response = await deleteService(clientId);
          invalidateProviderAccount();
          await recordServiceRemoval({ telegramId: String(owner.user.telegramId), username: clientId, actorId });
          return { ok: true, revoked: true, returnPrice: response.returnPrice, auditSummary: { revoked: true, alreadyGone: response.alreadyGone, ...(response.returnPrice != null ? { returnPrice: response.returnPrice } : {}) } };
        }
        throw new AdminServiceError("عملیات پشتیبانی نشده است.", { status: 400, code: "invalid_vpn_action" });
      } catch (error) {
        if (error instanceof AdminServiceError) throw error;
        const safe = new AdminServiceError(safeWizardError(error), { status: error?.ambiguous ? 503 : 502, code: error?.reason || error?.code || "wizard_api_failed" });
        safe.ambiguous = Boolean(error?.ambiguous);
        throw safe;
      } finally {
        invalidateServiceStatus(clientId);
        if (lease) await leases.release(lease).catch(() => {});
      }
    },
  });
  return result;
}

/** One `clients` row with the fields the panel shows. An allow-list: `sub_link` is a credential and never leaves here. */
function publicClient(row) {
  const number = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null);
  const unlimited = row.unlimited === true || (row.unlimited === undefined && Number(row.data_limit) === 0);
  return {
    username: typeof row.username === "string" ? row.username.slice(0, 128) : null,
    status: typeof row.status === "string" ? row.status.slice(0, 24) : null,
    test: row.test === true,
    unlimited,
    trafficGb: unlimited ? null : number(row.data_limit_gb ?? row.gig),
    usedGb: number(row.used_traffic_gb),
    remainingGb: unlimited ? null : number(row.remaining_traffic_gb),
    days: number(row.day),
    daysLeft: number(row.days_left),
    expiresAt: number(row.expire ?? row.expiration_time) ? new Date(number(row.expire ?? row.expiration_time) * 1000).toISOString() : null,
    createdAt: number(row.created_at) ? new Date(number(row.created_at) * 1000).toISOString() : null,
  };
}

async function knownUsernames(names) {
  const valid = names.filter((name) => typeof name === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(name));
  if (!valid.length) return new Set();
  const known = await User.find({ "services.username": { $in: valid } }).select("services.username").lean();
  return new Set(known.flatMap((user) => (user.services || []).map((service) => service.username)));
}

function clientsFailure(error) {
  return new AdminServiceError(safeWizardError(error), { status: error?.ambiguous ? 503 : 502, code: error?.reason || error?.code || "wizard_api_failed" });
}

/**
 * Services created through the API key (documented `clients` method), one page at a time, cross-checked against local user
 * records so unknown/orphan services are visible. This is the provider's stored copy, not live usage.
 */
export async function listRemoteClients({ actorId, page = 1, pageSize = 50 } = {}) {
  assertAdminUser(actorId);
  const safeSize = Math.min(REMOTE_PAGE_MAX, Math.max(1, Number.isSafeInteger(Number(pageSize)) ? Number(pageSize) : 50));
  const safePage = Math.max(1, Number.isSafeInteger(Number(page)) ? Number(page) : 1);
  let response;
  try { response = await listClients({ limit: safeSize, offset: (safePage - 1) * safeSize }); }
  catch (error) { throw clientsFailure(error); }
  const items = response.items.filter((row) => row && typeof row === "object").map(publicClient);
  const known = await knownUsernames(items.map((row) => row.username));
  const total = response.total;
  return {
    source: "wizardxray",
    fetchedAt: new Date().toISOString(),
    page: safePage,
    pageSize: safeSize,
    total,
    pages: total == null ? null : Math.max(1, Math.ceil(total / safeSize)),
    count: items.length,
    items: items.map((row) => ({ ...row, knownLocally: known.has(row.username) })),
  };
}

/**
 * Evidence for an order whose `create` has an unknown outcome. The document's advice after a lost answer is to look before
 * repeating, and `create` has no idempotency key, so the only available evidence is a service nobody here knows about, with the
 * sold terms, created around the time of the attempt.
 *
 * This reads and reports. A match is a lead for the admin, not proof: two orders with the same terms can be in flight at once,
 * and it never settles the order. An empty result does not prove nothing was created either, because this list lags.
 */
export async function findProviderCandidates({ actorId, purchaseId } = {}) {
  assertAdminUser(actorId);
  const id = String(purchaseId ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new AdminServiceError("شناسه سفارش نامعتبر است.", { status: 400, code: "invalid_purchase_id" });
  const purchase = await WalletPurchase.findOne({ purchaseId: id }).select("gig days provisioningStartedAt createdAt status serviceUsername").lean();
  if (!purchase) throw new AdminServiceError("سفارش یافت نشد.", { status: 404, code: "purchase_not_found" });
  if (purchase.serviceUsername) return { candidates: [], scanned: 0, complete: true, settled: true };
  const startedAt = new Date(purchase.provisioningStartedAt || purchase.createdAt).getTime();
  const rows = [];
  let total = null;
  try {
    for (let offset = 0; offset < MATCH_MAX_ROWS; offset += MATCH_PAGE) {
      const page = await listClients({ limit: MATCH_PAGE, offset });
      rows.push(...page.items.filter((row) => row && typeof row === "object"));
      total = page.total ?? total;
      if (page.items.length < MATCH_PAGE) break;
    }
  } catch (error) { throw clientsFailure(error); }
  const clients = rows.map(publicClient);
  const known = await knownUsernames(clients.map((row) => row.username));
  const wantedUnlimited = purchase.gig === UNLIMITED_GIG;
  const candidates = clients.filter((row) => {
    const created = row.createdAt ? new Date(row.createdAt).getTime() : NaN;
    return !known.has(row.username) && !row.test && created >= startedAt - MATCH_EARLY_MS && created <= startedAt + MATCH_LATE_MS
      && row.unlimited === wantedUnlimited && (wantedUnlimited || row.trafficGb === purchase.gig) && (row.days == null || row.days === purchase.days);
  });
  return { candidates, scanned: clients.length, complete: total == null || clients.length >= total, settled: false };
}

/** The account as the provider reports it, for admins only: balance, prices, limits and locations. */
export async function getProviderOverview({ actorId } = {}) {
  assertAdminUser(actorId);
  const [account, hosts] = await Promise.all([
    getProviderAccount({ maxAgeMs: 15_000 }),
    getHosts().catch((error) => (error?.reason === "hosts_unavailable" ? [] : null)),
  ]);
  return { fetchedAt: new Date().toISOString(), available: Boolean(account), account, hosts };
}

/** What these terms cost this account now. `gig: 0` needs `unlimited` too, the same explicit choice as renewing. */
export async function getProviderQuote({ actorId, gig, days, unlimited } = {}) {
  assertAdminUser(actorId);
  const terms = { gig: unlimited === true ? UNLIMITED_GIG : parseGig(gig, { min: 0.5 }), days: parsePositiveInteger(days, { name: "days", min: 1, max: 3650 }) };
  try {
    return await quotePrice(terms.gig, terms.days);
  } catch (error) {
    throw new AdminServiceError(safeWizardError(error), { status: error?.reason === "unlimited_disabled" ? 409 : 502, code: error?.reason || error?.code || "wizard_api_failed" });
  }
}

export const isSafeWizardError = (error) => safeWizardError(error);
