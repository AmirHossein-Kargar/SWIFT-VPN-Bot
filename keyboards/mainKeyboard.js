import { isAdminUser } from "../utils/auth.js";

// Legacy Reply Keyboard labels. They are no longer rendered anywhere; they are
// kept only so a user whose Telegram client still shows the old persistent
// keyboard (and taps it) is routed correctly once and has the keyboard removed.
export const MOCK_TEST_BUTTON = "🧪 تست ماک";
export const ADMIN_PANEL_BUTTON = "👑 SWIFT ADMIN";
export const LEGACY_MENU_TEXT = Object.freeze({
  "🛒 خرید سرویس": "buy",
  "📦 سرویس‌های من": "services",
  "💰 افزایش موجودی": "topup",
  "🎁 سرویس تست": "test",
  "👤 پروفایل من": "profile",
  "🛠 پشتیبانی": "support",
  "📖 راهنما": "guide",
});

/** Callback prefix for customer main-menu navigation ("menu:<action>"). */
export const MENU_PREFIX = "menu:";

const CUSTOMER_ROWS = [
  [{ text: "🛒 خرید سرویس", callback_data: "menu:buy" }],
  [
    { text: "📦 سرویس‌های من", callback_data: "menu:services" },
    { text: "💰 افزایش موجودی", callback_data: "menu:topup" },
  ],
  [
    { text: "🎁 سرویس تست", callback_data: "menu:test" },
    { text: "👤 پروفایل من", callback_data: "menu:profile" },
  ],
  [
    { text: "🛠 پشتیبانی", callback_data: "menu:support" },
    { text: "📖 راهنما", callback_data: "menu:guide" },
  ],
];

const keyboard = {
  reply_markup: { inline_keyboard: CUSTOMER_ROWS },
};

/** Customer menu plus the admin-only row. Showing it is a convenience only:
 * every admin action re-checks authorization on the server. */
export const adminKeyboard = {
  reply_markup: {
    inline_keyboard: [
      ...CUSTOMER_ROWS,
      [
        { text: MOCK_TEST_BUTTON, callback_data: "adm:mock" },
        { text: ADMIN_PANEL_BUTTON, callback_data: "adm:home" },
      ],
    ],
  },
};

/** The admin row is offered only to allowlisted admins in a private chat. */
export function keyboardFor(userId, chatType = "private") {
  return chatType === "private" && isAdminUser(userId) ? adminKeyboard : keyboard;
}

export default keyboard;
