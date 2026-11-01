import AdminAccount from "../../models/AdminAccount.js";
import AdminAuditLog from "../../models/AdminAuditLog.js";
import User from "../../models/User.js";
import { getAdminIds } from "../../utils/auth.js";
import { isAdminBanned } from "../users/accessGate.js";
import { PRESENCE_WINDOW_SECONDS, readPanelPresence } from "./adminPresence.js";
import { getOwnerTelegramIds } from "./adminRegistry.js";
import { sanitizeAuditValue } from "./audit.js";
import { AdminServiceError, assertAdminUser } from "./authorization.js";
import { requireTelegramId } from "./validation.js";

/**
 * Read-only directory of admin profiles. It joins what is already recorded and never writes.
 *
 *   Who is an admin      ADMINS plus AdminAccount, resolved exactly as services/admin/adminRegistry.js does
 *   Name, username       User, refreshed by the bot on each private message (no User row: the admin never messaged the bot)
 *   Sign-ins             ADMIN_LOGIN and ADMIN_LOGOUT audit rows, which only the web panel writes
 *   Activity             AdminAuditLog actor rows, plus the panel presence record
 *
 * `User.lastActivityAt` is deliberately unused: production code writes it once, when the row is created, so it is a second
 * copy of the join date and would present a stale time as activity.
 */
const MAX_ACCOUNTS = 500;
const QUERY_TIMEOUT_MS = 5_000;
const DAY_MS = 86_400_000;
const HISTORY_LIMIT = 15;
const TOP_ACTIONS_LIMIT = 6;
const MAX_SEARCH_LENGTH = 64;
const SIGN_IN = "ADMIN_LOGIN";
const SIGN_OUT = "ADMIN_LOGOUT";
const SESSION_ACTIONS = [SIGN_IN, SIGN_OUT];
const ROLE_FILTERS = new Set(["owner", "admin"]);
const STATUS_FILTERS = new Set(["active", "blocked", "removed"]);
const VALID_TELEGRAM_ID = /^[1-9]\d{0,19}$/;

const ACCOUNT_FIELDS = "telegramId role displayName addedBy addedAt removedAt removedBy -_id";
const USER_FIELDS = "telegramId firstName lastName username createdAt isBanned blockedAt blockedBy blockReason -_id";
const DEFAULT_MODELS = Object.freeze({ accounts: AdminAccount, users: User, audits: AdminAuditLog });

function latestDate(...values) {
  const times = values.filter(Boolean).map((value) => new Date(value).getTime()).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * "Online" takes positive evidence: a signed-in panel request inside the window with no later sign-out. Silence is never
 * read as a state. No record stays unknown, and so does a Redis that cannot answer.
 */
export function derivePresence({ lastSeenAt = null, lastLogoutAt = null, available = true, active = true, now = Date.now() } = {}) {
  if (!available) return { state: "unknown", reason: "unavailable" };
  if (!lastSeenAt) return active ? { state: "unknown", reason: "no_record" } : { state: "offline", reason: null };
  const seen = new Date(lastSeenAt).getTime();
  const signedOut = lastLogoutAt ? new Date(lastLogoutAt).getTime() : 0;
  const recent = now - seen <= PRESENCE_WINDOW_SECONDS * 1000;
  return { state: active && recent && signedOut <= seen ? "online" : "offline", reason: null };
}

/**
 * An admin's access comes from ADMINS and AdminAccount alone. A block on their customer record is not enforced against an
 * allow-listed admin (services/users/accessGate.js), so "blocked" is a flag worth seeing, not a loss of access.
 */
export function deriveStatus({ active, user }) {
  if (!active) return "removed";
  return user?.isBanned ? "blocked" : "active";
}

function describeBlock(user) {
  if (!user?.isBanned) return null;
  return {
    kind: isAdminBanned(user) ? "by_admin" : "bot_blocked_by_account",
    at: user.blockedAt || null,
    by: isAdminBanned(user) ? user.blockedBy || null : null,
    reason: user.blockReason || null,
  };
}

/** Merges one admin's records. Every field that has no source stays null, and the panel labels it. */
export function buildProfile({ telegramId, source, active, account = null, user = null, ownerIds = [], audit = {}, presence = {}, available = true, now = Date.now() }) {
  const lastSeenAt = presence.lastSeenAt || null;
  const lastLogoutAt = audit.lastLogoutAt || null;
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || null;
  return {
    telegramId,
    name,
    displayName: account?.displayName || null,
    username: user?.username || null,
    role: ownerIds.includes(telegramId) ? "owner" : source === "database" ? account?.role || "admin" : "admin",
    source,
    status: deriveStatus({ active, user }),
    hasBotProfile: Boolean(user),
    joinedAt: user?.createdAt || null,
    adminSince: account?.addedAt || null,
    addedBy: account?.addedBy || null,
    removedAt: active ? null : account?.removedAt || null,
    removedBy: active ? null : account?.removedBy || null,
    block: describeBlock(user),
    lastLoginAt: audit.lastLoginAt || null,
    lastLogoutAt,
    lastActionAt: audit.lastActionAt || null,
    lastSeenAt,
    lastActivityAt: latestDate(lastSeenAt, audit.lastActionAt),
    eventsLast30Days: audit.eventsLast30Days || 0,
    presence: derivePresence({ lastSeenAt, lastLogoutAt, available, active, now }),
  };
}

export function normalizeDirectoryFilters({ search, role, status } = {}) {
  return {
    search: typeof search === "string" ? search.trim().replace(/^@/, "").slice(0, MAX_SEARCH_LENGTH).toLowerCase() : "",
    role: ROLE_FILTERS.has(role) ? role : "all",
    status: STATUS_FILTERS.has(status) ? status : "all",
  };
}

/** A plain substring match over a short list, so a search can never become a costly pattern. */
export function matchesDirectoryFilters(profile, { search, role, status }) {
  if (role !== "all" && profile.role !== role) return false;
  if (status !== "all" && profile.status !== status) return false;
  if (!search) return true;
  return [profile.name, profile.displayName, profile.username, profile.telegramId].some((value) => value?.toLowerCase().includes(search));
}

const STATUS_ORDER = { active: 0, blocked: 1, removed: 2 };
const time = (value) => (value ? new Date(value).getTime() : 0);

/** Current admins first, the owner leading them, then the most recently active. */
export function sortProfiles(profiles) {
  return [...profiles].sort((a, b) => (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || Number(b.role === "owner") - Number(a.role === "owner")
    || time(b.lastActivityAt) - time(a.lastActivityAt)
    || a.telegramId.localeCompare(b.telegramId)
  ));
}

export function summarizeProfiles(profiles, presenceAvailable) {
  const count = (test) => profiles.filter(test).length;
  return {
    total: profiles.length,
    active: count((profile) => profile.status !== "removed"),
    blocked: count((profile) => profile.status === "blocked"),
    removed: count((profile) => profile.status === "removed"),
    online: presenceAvailable ? count((profile) => profile.presence.state === "online") : null,
  };
}

/** One entry per admin, environment first. ADMINS wins when an ID is in both, as it does for authorization. */
function resolveMembers(accounts) {
  const environment = new Set(getAdminIds().map(String));
  const rows = new Map(accounts.filter((row) => VALID_TELEGRAM_ID.test(String(row.telegramId ?? ""))).map((row) => [String(row.telegramId), row]));
  const members = [...environment].map((telegramId) => ({ telegramId, source: "environment", active: true, account: rows.get(telegramId) ?? null }));
  for (const [telegramId, account] of rows) {
    if (!environment.has(telegramId)) members.push({ telegramId, source: "database", active: !account.removedAt, account });
  }
  return members;
}

async function auditSummaries(ids, audits, now) {
  const options = { maxTimeMS: QUERY_TIMEOUT_MS };
  // One query per action on purpose: grouping by a single field lets MongoDB jump straight to each admin's newest row
  // (DISTINCT_SCAN, 2 keys in the index plan test). Grouping by actor and action together walks every session row instead.
  const latestOf = (action) => audits.aggregate([
    { $match: { actorTelegramId: { $in: ids }, action } },
    { $sort: { actorTelegramId: 1, action: 1, createdAt: -1 } },
    { $group: { _id: "$actorTelegramId", at: { $first: "$createdAt" } } },
  ]).option(options);
  const [latest, signIns, signOuts, recent] = await Promise.all([
    audits.aggregate([
      { $match: { actorTelegramId: { $in: ids } } },
      { $sort: { actorTelegramId: 1, createdAt: -1 } },
      { $group: { _id: "$actorTelegramId", at: { $first: "$createdAt" } } },
    ]).option(options),
    latestOf(SIGN_IN),
    latestOf(SIGN_OUT),
    audits.aggregate([
      { $match: { actorTelegramId: { $in: ids }, createdAt: { $gte: new Date(now - 30 * DAY_MS) } } },
      { $group: { _id: "$actorTelegramId", count: { $sum: 1 } } },
    ]).option(options),
  ]);

  const summaries = new Map(ids.map((id) => [id, {}]));
  const assign = (rows, field, value) => { for (const row of rows) { const entry = summaries.get(row._id); if (entry) entry[field] = value(row); } };
  assign(latest, "lastActionAt", (row) => row.at);
  assign(signIns, "lastLoginAt", (row) => row.at);
  assign(signOuts, "lastLogoutAt", (row) => row.at);
  assign(recent, "eventsLast30Days", (row) => row.count);
  return summaries;
}

async function buildProfiles(members, { models, presenceReader, now }) {
  const ids = members.map((member) => member.telegramId);
  if (ids.length === 0) return { profiles: [], available: true };
  const [users, audits, presence] = await Promise.all([
    models.users.find({ telegramId: { $in: ids } }).select(USER_FIELDS).lean().maxTimeMS(QUERY_TIMEOUT_MS),
    auditSummaries(ids, models.audits, now),
    presenceReader(ids),
  ]);
  const usersById = new Map(users.map((user) => [String(user.telegramId), user]));
  const ownerIds = getOwnerTelegramIds();
  const profiles = members.map((member) => buildProfile({
    ...member,
    user: usersById.get(member.telegramId) ?? null,
    ownerIds,
    audit: audits.get(member.telegramId),
    presence: { lastSeenAt: presence.lastSeen.get(member.telegramId) ?? null },
    available: presence.available,
    now,
  }));
  return { profiles, available: presence.available };
}

export async function getAdminDirectory({ actorId, search, role, status, models = DEFAULT_MODELS, presenceReader = readPanelPresence, now = Date.now() } = {}) {
  assertAdminUser(actorId);
  const filters = normalizeDirectoryFilters({ search, role, status });
  const accounts = await models.accounts.find({}).sort({ addedAt: -1 }).limit(MAX_ACCOUNTS + 1).select(ACCOUNT_FIELDS).lean().maxTimeMS(QUERY_TIMEOUT_MS);
  const { profiles, available } = await buildProfiles(resolveMembers(accounts.slice(0, MAX_ACCOUNTS)), { models, presenceReader, now });
  return {
    items: sortProfiles(profiles.filter((profile) => matchesDirectoryFilters(profile, filters))),
    summary: summarizeProfiles(profiles, available),
    presence: { available, windowSeconds: PRESENCE_WINDOW_SECONDS },
    truncated: accounts.length > MAX_ACCOUNTS,
    generatedAt: new Date(now).toISOString(),
  };
}

const AUDIT_FIELDS = "action targetType targetId status errorCode ipAddress createdAt -_id";
const HISTORY_FIELDS = "actorTelegramId action status createdAt -_id";

export async function getAdminDirectoryProfile({ actorId, telegramId, models = DEFAULT_MODELS, presenceReader = readPanelPresence, now = Date.now() } = {}) {
  assertAdminUser(actorId);
  const id = requireTelegramId(telegramId);
  const accounts = await models.accounts.find({ telegramId: id }).select(ACCOUNT_FIELDS).lean().maxTimeMS(QUERY_TIMEOUT_MS);
  const member = resolveMembers(accounts).find((entry) => entry.telegramId === id);
  if (!member) throw new AdminServiceError("Admin not found.", { status: 404, code: "admin_not_found" });

  const actor = { actorTelegramId: id };
  const sinceMonth = new Date(now - 30 * DAY_MS);
  const newestFirst = { createdAt: -1 };
  const audits = models.audits;
  const [{ profiles, available }, totalEvents, eventsLast7Days, grouped, signInsLast30Days, recentActions, sessionHistory, accountHistory] = await Promise.all([
    buildProfiles([member], { models, presenceReader, now }),
    audits.countDocuments(actor).maxTimeMS(QUERY_TIMEOUT_MS),
    audits.countDocuments({ ...actor, createdAt: { $gte: new Date(now - 7 * DAY_MS) } }).maxTimeMS(QUERY_TIMEOUT_MS),
    audits.aggregate([
      { $match: { ...actor, createdAt: { $gte: sinceMonth } } },
      { $group: { _id: "$action", count: { $sum: 1 }, failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } } } },
    ]).option({ maxTimeMS: QUERY_TIMEOUT_MS }),
    audits.countDocuments({ ...actor, action: SIGN_IN, createdAt: { $gte: sinceMonth } }).maxTimeMS(QUERY_TIMEOUT_MS),
    audits.find({ ...actor, action: { $nin: SESSION_ACTIONS } }).sort(newestFirst).limit(HISTORY_LIMIT).select(AUDIT_FIELDS).lean().maxTimeMS(QUERY_TIMEOUT_MS),
    audits.find({ ...actor, action: { $in: SESSION_ACTIONS } }).sort(newestFirst).limit(HISTORY_LIMIT).select(AUDIT_FIELDS).lean().maxTimeMS(QUERY_TIMEOUT_MS),
    audits.find({ targetType: "admin", targetId: id }).sort(newestFirst).limit(HISTORY_LIMIT).select(HISTORY_FIELDS).lean().maxTimeMS(QUERY_TIMEOUT_MS),
  ]);

  const counted = [...grouped].sort((a, b) => b.count - a.count || a._id.localeCompare(b._id));
  return {
    profile: profiles[0],
    stats: {
      totalEvents,
      eventsLast7Days,
      eventsLast30Days: counted.reduce((sum, row) => sum + row.count, 0),
      failedLast30Days: counted.reduce((sum, row) => sum + row.failed, 0),
      signInsLast30Days,
      topActions: counted.slice(0, TOP_ACTIONS_LIMIT).map((row) => ({ action: row._id, count: row.count, failed: row.failed })),
    },
    // The same sanitizer as the audit log route, so this view can show nothing that route would hide.
    recentActions: recentActions.map((row) => sanitizeAuditValue(row)),
    sessionHistory: sessionHistory.map((row) => sanitizeAuditValue(row)),
    accountHistory: accountHistory.map((row) => sanitizeAuditValue(row)),
    presence: { available, windowSeconds: PRESENCE_WINDOW_SECONDS },
    generatedAt: new Date(now).toISOString(),
  };
}
