/** Shapes and wording for /panel/admins. A field with no source is null, and the panel says so instead of guessing. */

export type AdminStatus = "active" | "blocked" | "removed";
export type AdminPresenceState = "online" | "offline" | "unknown";

export interface AdminProfile {
  telegramId: string;
  name: string | null;
  displayName: string | null;
  username: string | null;
  role: "owner" | "admin";
  source: "environment" | "database";
  status: AdminStatus;
  hasBotProfile: boolean;
  joinedAt: string | null;
  adminSince: string | null;
  addedBy: string | null;
  removedAt: string | null;
  removedBy: string | null;
  block: { kind: "by_admin" | "bot_blocked_by_account"; at: string | null; by: string | null; reason: string | null } | null;
  lastLoginAt: string | null;
  lastLogoutAt: string | null;
  lastActionAt: string | null;
  lastSeenAt: string | null;
  lastActivityAt: string | null;
  eventsLast30Days: number;
  presence: { state: AdminPresenceState; reason: "unavailable" | "no_record" | null };
}

export interface AdminDirectoryPresence {
  available: boolean;
  windowSeconds: number;
}

export interface AdminDirectoryData {
  items: AdminProfile[];
  summary: { total: number; active: number; blocked: number; removed: number; online: number | null };
  presence: AdminDirectoryPresence;
  truncated: boolean;
  generatedAt: string;
}

export interface AdminAuditRow {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  status: string;
  errorCode?: string | null;
  ipAddress?: string | null;
  actorTelegramId?: string;
  createdAt: string;
}

export interface AdminProfileDetail {
  profile: AdminProfile;
  stats: {
    totalEvents: number;
    eventsLast7Days: number;
    eventsLast30Days: number;
    failedLast30Days: number;
    signInsLast30Days: number;
    topActions: { action: string; count: number; failed: number }[];
  };
  recentActions: AdminAuditRow[];
  sessionHistory: AdminAuditRow[];
  accountHistory: AdminAuditRow[];
  presence: AdminDirectoryPresence;
  generatedAt: string;
}

/** Told plainly on the Security tab, so an empty history is never read as "nothing happened". */
export const NOT_RECORDED = [
  "Failed sign-ins: only successful ones are logged, and a wrong code cannot be tied to an admin.",
  "Device, browser and location of a sign-in.",
  "Open web sessions per admin: sessions are stored by token, not by admin.",
  "Telegram panel visits and read-only browsing: only actions are audited.",
  "Email, phone and bio: the bot never collects them.",
] as const;

export const STATUS_LABELS: Record<AdminStatus, string> = { active: "Active", blocked: "Blocked in bot", removed: "Removed" };
export const ROLE_LABELS: Record<AdminProfile["role"], string> = { owner: "Owner", admin: "Admin" };
export const SOURCE_LABELS: Record<AdminProfile["source"], string> = { environment: "ADMINS variable", database: "Added in panel" };

/** The best name on record: Telegram's, then the one the owner typed, then the handle, then the ID. */
export function adminLabel(profile: Pick<AdminProfile, "name" | "displayName" | "username" | "telegramId">): string {
  return profile.name ?? profile.displayName ?? (profile.username ? `@${profile.username}` : profile.telegramId);
}

export function presenceLabel({ state, reason }: AdminProfile["presence"]): string {
  if (state === "online") return "Online";
  if (state === "offline") return "Offline";
  return reason === "unavailable" ? "Status unavailable" : "Not seen in panel";
}

/** Measured against the server's clock, so the server and browser render the same text and a skewed device changes nothing. */
export function formatSince(value: string | null | undefined, generatedAt: string): string | null {
  if (!value) return null;
  const elapsed = new Date(generatedAt).getTime() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return null;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}

export function auditedEvents(count: number): string {
  return `${count.toLocaleString("en-US")} audited ${count === 1 ? "event" : "events"}`;
}

export function actionLabel(action: string): string {
  const text = action.replaceAll("_", " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Telegram's own username rule. Anything else on record is shown as text, never as a link. */
export function telegramProfileUrl(username: string | null): string | null {
  return username && /^[A-Za-z0-9_]{4,32}$/.test(username) ? `https://t.me/${username}` : null;
}

export function blockExplanation(block: NonNullable<AdminProfile["block"]>): string {
  if (block.kind === "bot_blocked_by_account") {
    return "A past Telegram delivery failed because this account blocked the bot. If that is still true, sign-in codes cannot reach it.";
  }
  return "Their customer account carries a block. Allow-listed admins are not gated by it, so it does not limit their admin access.";
}
