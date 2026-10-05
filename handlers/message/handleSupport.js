import { getSupportMessage, getSupportDirectButton } from "../../messages/supportContact.js";
import { renderUiScreen } from "../../utils/telegramUi.js";
import { getSession, setSession } from "../../config/sessionStore.js";

const handleSupport = async (bot, chatId, userId, messageId) => {
  const supportMessage = getSupportMessage();
  const reply_markup = {
    inline_keyboard: [
      ...getSupportDirectButton(),
      [{ text: "🏠 منوی اصلی", callback_data: "back_to_home" }],
    ],
  };

  const rendered = await renderUiScreen(
    bot,
    chatId,
    messageId,
    supportMessage,
    { reply_markup },
    { step: null, support: true, supportMessageId: null }
  );

  // Keep support mode bound to this user's current private UI message. Typed
  // support text is forwarded by the normal message handler and deleted on a
  // best-effort basis; navigation returns to the same editable message.
  const session = await getSession(userId);
  await setSession(userId, {
    ...session,
    support: true,
    supportMessageId: rendered?.message_id ?? session.uiMessageId ?? null,
  });
  return rendered;
};

export default handleSupport;
