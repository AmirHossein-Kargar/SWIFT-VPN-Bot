import { payNowPayments } from "./payNowPayments.js";

// Old TRON buttons must not start the direct-wallet amount step. That step
// used the legacy market-price providers and is no longer a customer path.
export default function payTrx(bot, query, session) {
  return payNowPayments(bot, query, session);
}
