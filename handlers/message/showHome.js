import keyboard from "../../keyboards/mainKeyboard.js";
import { WELCOME_MESSAGE } from "../../messages/staticMessages.js";
import { renderUiScreen } from "../../utils/telegramUi.js";

/** Render/reset the single persistent customer-facing menu message. */
export default async function showHome(bot, chatId, messageId) {
  return renderUiScreen(
    bot,
    chatId,
    messageId,
    WELCOME_MESSAGE,
    keyboard,
    {
      step: null,
      paymentId: null,
      paymentType: null,
      rawAmount: null,
      support: false,
      supportMessageId: null,
    }
  );
}
