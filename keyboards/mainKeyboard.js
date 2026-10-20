import { isAdminUser } from "../utils/auth.js";

export const MOCK_TEST_BUTTON = "🧪 تست ماک";
export const ADMIN_PANEL_BUTTON = "👑 SWIFT ADMIN";

const CUSTOMER_ROWS = [
  ["🛒 خرید سرویس"],
  ["📦 سرویس‌های من", "💰 افزایش موجودی"],
  ["🎁 سرویس تست", "👤 پروفایل من"],
  ["🛠 پشتیبانی", "📖 راهنما"],
];

const keyboard = {
  reply_markup: {
    keyboard: CUSTOMER_ROWS,
    resize_keyboard: true,
    one_time_keyboard: false,
  },
};

/** Customer menu plus the admin-only row. Showing it is a convenience only:
 * every admin action re-checks authorization on the server. */
export const adminKeyboard = {
  reply_markup: {
    keyboard: [...CUSTOMER_ROWS, [MOCK_TEST_BUTTON, ADMIN_PANEL_BUTTON]],
    resize_keyboard: true,
    one_time_keyboard: false,
  },
};

/** The admin row is offered only to allowlisted admins in a private chat. */
export function keyboardFor(userId, chatType = "private") {
  return chatType === "private" && isAdminUser(userId) ? adminKeyboard : keyboard;
}

export default keyboard;
