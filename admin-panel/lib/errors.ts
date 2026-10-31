import { AdminApiError } from "./types";

/**
 * The admin services are shared with the Persian Telegram admin panel, so
 * their safe messages are often Persian. The web panel is English-only:
 * known error codes map to English here, and any non-Latin server message
 * falls back to a generic English one instead of being shown verbatim.
 */
const MESSAGES: Record<string, string> = {
  unauthorized: "Your session has expired. Sign in again.",
  csrf_token_invalid: "Security check failed. Reload the page and try again.",
  origin_not_allowed: "Request blocked: it did not come from this site.",
  session_store_unavailable: "The session store is unavailable. Try again shortly.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  forbidden: "You are not allowed to do that.",
  owner_only: "Only the primary owner can do that.",
  owner_protected: "The primary owner cannot be removed.",
  admin_from_environment: "This admin is defined in the ADMINS environment variable and can only be removed there.",
  invalid_admin_id: "Enter a valid positive Telegram ID.",
  admin_already_owner: "That ID is the primary owner and already has full access.",
  idempotency_conflict: "This request was already used for a different action. Try again.",
  action_in_progress: "This action is already in progress or needs manual review. Check the audit log before retrying.",
  audit_unavailable: "The audit log is unavailable, so the action was not performed.",
  invalid_operation_id: "Invalid request. Reload the page and try again.",
  invalid_reason: "Enter a reason (at least a few words).",
  confirmation_required: "A reason is required for this action.",
  user_not_found: "User not found.",
  invalid_user_id: "Invalid Telegram ID.",
  insufficient_balance: "The user's balance is too low for this debit. Debits never overdraw a wallet.",
  invalid_balance_action: "Choose credit or debit.",
  invalid_amount: "Enter a valid whole amount.",
  invalid_block_state: "Invalid block state.",
  test_service_in_progress: "The user's test service is being provisioned or awaits manual review. Try again after it is resolved.",
  test_service_delivery_pending: "The previous test-service link has not been delivered to the user yet.",
  test_service_state_changed: "The test-service state changed at the same time. Try again.",
  invalid_message: "Enter a message (up to 3,500 characters, no control characters).",
  recipient_unreachable: "Telegram refused the message: the user blocked the bot or deactivated their account.",
  chat_not_found: "The user never started the bot, so Telegram cannot deliver to them.",
  telegram_rate_limited: "Telegram rate-limited the bot. Try again shortly.",
  telegram_rejected: "Telegram rejected the message.",
  delivery_unknown: "The delivery outcome is unknown (network error). Check with the user before sending again.",
  bot_unavailable: "The Telegram bot is not running on this server.",
  broadcast_already_running: "Another broadcast is still sending. Wait for it to finish or cancel it first.",
  broadcast_lock_unavailable: "The broadcast lock service (Redis) is unavailable, so nothing was sent. Try again shortly.",
  mock_run_in_progress: "A mock-test run is already in progress. Wait for it to finish.",
  mock_run_rate_limited: "A run just finished. Wait a few seconds before starting another.",
  invalid_mock_scenario: "Unknown mock-test scenario.",
  invalid_mock_run_id: "Invalid mock-test run ID.",
  mock_run_not_found: "That mock-test report no longer exists.",
  vpn_action_in_progress: "Another action is running on this VPN service.",
  invalid_vpn_action: "Unsupported VPN action.",
  wizard_api_failed: "The VPN panel could not complete the request.",
  wizard_action_unavailable: "The VPN panel does not support this action.",
  invalid_gig: "Traffic must be at least 0.5 GB (up to two decimals).",
  product_not_found: "Plan not found.",
  finding_still_reproduces: "The records still show this problem, so it cannot be marked resolved yet.",
  finding_no_longer_reproduces: "The records no longer show this problem. Reload the page.",
  review_conflict: "Another admin changed this finding first. Reload and try again.",
  review_transition_refused: "This finding cannot move to that status.",
  invalid_option: "Choose one of the offered options.",
  sentinel_disabled: "Sentinel is switched off on this server.",
  sentinel_run_failed: "The check could not finish. Nothing was changed; try again shortly.",
  timeout: "The request timed out. It may still complete on the server; refresh before retrying.",
  network_error: "Network error. Check your connection and try again.",
};

const NON_LATIN = /[֐-ࣿ]/;

export function describeError(error: unknown, fallback = "The request failed."): string {
  if (error instanceof AdminApiError) {
    const known = MESSAGES[error.code];
    if (known) return known;
    if (error.message && !NON_LATIN.test(error.message)) return error.message;
    return fallback;
  }
  if (error instanceof DOMException && error.name === "AbortError") return MESSAGES.timeout ?? fallback;
  if (error instanceof TypeError) return MESSAGES.network_error ?? fallback;
  return fallback;
}
