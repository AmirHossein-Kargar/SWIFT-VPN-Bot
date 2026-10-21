/**
 * Text-input steps (payment amounts, admin prompts) expire so an abandoned
 * prompt can never turn a much later, unrelated message into a payment amount
 * or admin action. Sessions without a timestamp (written before this change)
 * are treated as live: they still expire with the 7-day session TTL.
 */
export const INPUT_STEP_TTL_MS = 30 * 60 * 1000;

const EXPIRING_STEPS = new Set([
  "waiting_for_bank_amount",
  "waiting_for_trx_amount",
  "waiting_for_hoosh_amount",
  "waiting_for_nowpayments_amount",
  "waiting_for_nowpayments_currency",
  "waiting_for_nowpayments_network",
  "waiting_for_api_gig",
  "waiting_for_api_days",
  "waiting_for_config_details",
  "waiting_for_vpn_id",
  "admin_waiting_for_user_id",
  "admin_waiting_for_message",
  "admin_waiting_for_hoosh_search",
]);

export function isInputStepExpired(session, now = Date.now()) {
  if (!session?.step || !EXPIRING_STEPS.has(session.step)) return false;
  const at = Number(session.updatedAt);
  return Number.isFinite(at) && at > 0 && now - at > INPUT_STEP_TTL_MS;
}
