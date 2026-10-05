import { createWalletPurchase } from "./purchaseLedger.js";

/** Reserve wallet funds, provision once, and durably record delivery/recovery state. */
export default async function handlePlanOrder(bot, chatId, userId, plan, options = {}) {
  return createWalletPurchase(bot, chatId, userId, plan, options);
}
