/**
 * Ownership of multi-step admin text prompts.
 *
 * These prompts keep their state in the admin GROUP's session (keyed by the chat),
 * so without an owner anyone in that group could answer a prompt another admin
 * opened. Every such session therefore records the admin who started it
 * (`adminUserId`) and may only be continued by that same admin, who must still be
 * authorized when the message arrives. Anything else fails closed.
 */
import { isAdmin } from "./auth.js";
import { isInputStepExpired } from "./inputExpiry.js";

/** Steps that perform a privileged action (or hand data to one) from a free-text reply. */
export const ADMIN_TEXT_STEPS = Object.freeze(new Set([
  "admin_waiting_for_hoosh_search",
  "admin_waiting_for_user_id",
  "admin_waiting_for_message",
  "waiting_for_config_details",
  "waiting_for_vpn_id",
  "waiting_for_api_gig",
  "waiting_for_api_days",
  "waiting_for_api_confirmation",
]));

/** Marker field (not a step) recording a provider purchase that is running or whose outcome is unknown. */
export const API_PURCHASE_IN_PROGRESS = "in_progress";

const TELEGRAM_ID = /^[1-9]\d{0,19}$/;

export function isAdminTextStep(step) {
  return typeof step === "string" && ADMIN_TEXT_STEPS.has(step);
}

function normalizedId(value) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" && TELEGRAM_ID.test(text) ? text : null;
}

/** Session fields that bind a prompt to the admin who opened it. */
export function adminOwnerFields(adminUserId) {
  return { adminUserId: normalizedId(adminUserId) };
}

/**
 * True when the shared chat session holds another admin's ACTIVE privileged prompt (or a running
 * provider purchase) that `userId` does not own. Callers that would wipe or replace the chat
 * session must leave it untouched in that case. An expired prompt is no longer active, and any
 * session that is not an admin prompt is never protected.
 */
export function isActiveForeignAdminPrompt({ session, chatId, userId, now = Date.now() }) {
  const purchaseRunning = session?.apiPurchase?.state === API_PURCHASE_IN_PROGRESS;
  if (!purchaseRunning) {
    if (!isAdminTextStep(session?.step)) return false;
    if (isInputStepExpired(session, now)) return false;
  }
  return !canContinueAdminStep({ session, chatId, userId });
}

/**
 * True only when `userId` is the admin recorded in the session AND is currently an
 * authorized admin of this chat. A missing, malformed or different owner is false.
 */
export function canContinueAdminStep({ session, chatId, userId }) {
  const sender = normalizedId(userId);
  const owner = normalizedId(session?.adminUserId);
  if (!sender || !owner || sender !== owner) return false;
  return isAdmin(chatId, Number(sender));
}
