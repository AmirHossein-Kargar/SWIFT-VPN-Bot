/**
 * Callback-query reliability helpers.
 *
 * - withSingleAck: every query is answered exactly once, whatever the handler does.
 * - claimCallback: short-lived dedupe for rapid repeat taps of state-changing buttons.
 *
 * Neither is a financial safeguard on its own. Payment/provisioning idempotency
 * and Redis locks live in the services and are unchanged; this only stops a
 * burst of identical taps from reaching them at all.
 */

/** Callback prefixes whose repeated tap must not run twice in quick succession. */
const SENSITIVE_PREFIXES = [
  "confirm_order_", "confirm_payment_", "reject_payment_", "confirm_delete_service_",
  "delete_service_", "deactivate_service_", "change_link_", "send_config_to_user_",
  "hoosh_verify:", "admin_hoosh_resend:", "admin_hoosh_run_pending",
  "pay_hoosh", "pay_nowpayments", "pay_trx", "np_create", "np_select_currency", "np_cancel",
  "menu:test", "sup_", "admin_scan_trx_wallet",
];

const DEDUPE_WINDOW_MS = 2_000;
const recent = new Map();

export function isSensitiveCallback(data) {
  return typeof data === "string" && SENSITIVE_PREFIXES.some((prefix) => data.startsWith(prefix));
}

/** Returns false when the same user already tapped the same button on the same message moments ago. */
export function claimCallback({ userId, messageId, data, now = Date.now() }) {
  if (!isSensitiveCallback(data)) return true;
  const key = `${userId}:${messageId}:${data}`;
  const last = recent.get(key);
  if (last != null && now - last < DEDUPE_WINDOW_MS) return false;
  recent.set(key, now);
  if (recent.size > 2_000) {
    for (const [k, t] of recent) if (now - t >= DEDUPE_WINDOW_MS) recent.delete(k);
  }
  return true;
}

export function resetCallbackGuardForTests() {
  recent.clear();
}

/**
 * Wrap `bot` so answerCallbackQuery(queryId, …) goes through at most once per
 * query. Returns the wrapped bot plus ensureAnswered() for the end of handling.
 */
export function withSingleAck(bot, queryId) {
  let answered = false;
  const answer = async (id, options) => {
    if (id !== queryId) return bot.answerCallbackQuery(id, options);
    if (answered) return false;
    answered = true;
    try {
      return await bot.answerCallbackQuery(id, options);
    } catch {
      return false; // expired/invalid query: nothing more can be shown
    }
  };
  const wrapped = new Proxy(bot, {
    get(target, prop) {
      if (prop === "answerCallbackQuery") return answer;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    bot: wrapped,
    ensureAnswered: async () => { if (queryId != null && !answered) await answer(queryId); },
    wasAnswered: () => answered,
  };
}
