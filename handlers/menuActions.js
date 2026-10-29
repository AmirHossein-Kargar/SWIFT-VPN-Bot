import { clearSession } from "../config/sessionStore.js";
import { keyboardFor, LEGACY_MENU_TEXT } from "../keyboards/mainKeyboard.js";
import { CHOOSE_OPTION_MESSAGE } from "../messages/staticMessages.js";
import { renderInterface } from "../services/messaging/messageManager.js";
import handleBuyService from "../services/buyService/buyService.js";
import sendServiceSelectionMenu from "../services/manageServices/sendServiceSelectionMenu.js";
import createTestService from "../services/createTestService.js";
import showPaymentMethods from "./message/showPaymentMethods.js";
import handleProfile from "./message/handleProfile.js";
import handleGuide from "./message/handleGuide.js";
import { showSupportMenu } from "./support/supportFlow.js";

export const MENU_ACTIONS = Object.freeze(["buy", "services", "topup", "test", "profile", "support", "guide", "home"]);

/** Resolve a legacy Reply-Keyboard label to a menu action (or null). */
export function legacyMenuAction(text) {
  return Object.hasOwn(LEGACY_MENU_TEXT, text) ? LEGACY_MENU_TEXT[text] : null;
}

/**
 * Show the main menu. When `messageId` is known the current screen is edited in
 * place; otherwise (or if Telegram refuses the edit) one fresh message is sent.
 */
export async function showMainMenu(bot, { chatId, userId, chatType = "private", messageId, text = CHOOSE_OPTION_MESSAGE }) {
  return renderInterface(bot, {
    chatId,
    text,
    messageId,
    options: keyboardFor(userId, chatType).reply_markup ? { reply_markup: keyboardFor(userId, chatType).reply_markup } : {},
  });
}

/**
 * Run one customer main-menu action. Shared by the inline `menu:<action>`
 * callbacks and the one-time legacy Reply-Keyboard text fallback, so both reach
 * exactly the same business code. Navigation only: every action re-reads its own
 * data and re-applies its own wallet / ownership / role checks.
 *
 * Leaving to the menu discards any half-finished text-input state, so a later
 * message can never be read as a payment amount or support reply by accident.
 */
export async function runMenuAction(bot, { action, chatId, userId, chat, from, messageId }) {
  if (!MENU_ACTIONS.includes(action)) return false;
  const chatType = chat?.type || "private";

  if (action === "home") {
    await clearSession(chatId).catch(() => {});
    await showMainMenu(bot, { chatId, userId, chatType, messageId });
    return true;
  }

  // Support keeps its own session (compose mode, standing message id), so it is
  // entered without wiping it; every other action starts from a clean session.
  if (action !== "support") await clearSession(chatId).catch(() => {});

  switch (action) {
    case "buy":
      await handleBuyService(bot, chatId, { messageId });
      break;
    case "services":
      await sendServiceSelectionMenu(bot, chatId, userId, { messageId });
      break;
    case "topup":
      await showPaymentMethods(bot, chatId, { messageId });
      break;
    case "test":
      await createTestService(bot, { chat: chat || { id: chatId, type: "private" }, from: from || { id: userId } }, { messageId });
      break;
    case "profile":
      await handleProfile(bot, chatId, userId, { messageId });
      break;
    case "support":
      await showSupportMenu(bot, chatId, userId, { messageId });
      break;
    case "guide":
      await handleGuide(bot, chatId, { messageId });
      break;
  }
  return true;
}
