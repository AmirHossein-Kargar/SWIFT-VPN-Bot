import trxScanner from "../../services/trxWalletScanner.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import bankInvoice from "../../models/invoice.js";
import { plans30, plans60, plans90 } from "../../services/plans.js";
import { sumAmount, sumUserBalances } from "../../services/admin/collectionStats.js";
import { estimateCatalogConsumption } from "../../services/admin/reportMath.js";
import { isAdmin } from "../../utils/auth.js";
import { handleAdminPanelCommand } from "./panel.js";
import hideKeyboard from "../../utils/hideKeyboard.js";

// ارسال پیام به گروه ادمین
const sendToAdminGroup = async (bot, message, keyboard = null) => {
  const groupId = process.env.GROUP_ID;

  if (!groupId) {
    console.error("❌ GROUP_ID not found in environment variables");
    return;
  }

  try {
    const options = {
      parse_mode: "HTML",
    };

    if (keyboard) {
      options.reply_markup = keyboard;
    }

    const result = await bot.sendMessage(groupId, message, options);
    return result;
  } catch (error) {
    console.error("❌ Error sending message to admin group:", error.message);
    throw error;
  }
};

// منوی گروه ادمین — Inline Keyboard. Every callback re-checks isAdmin(chatId, userId)
// server-side; showing the buttons grants nothing.
const getGroupKeyboard = () => ({
  inline_keyboard: [
    [
      { text: "🔍 اسکن ولت TRX", callback_data: "admin_scan_trx_wallet" },
      { text: "📊 وضعیت سیستم", callback_data: "admin_status" },
    ],
    [
      { text: "📋 سفارشات جدید", callback_data: "adm:pay:recovery-required:1" },
      { text: "💰 گزارش مالی", callback_data: "admin_financial_report" },
    ],
    [
      { text: "⚙️ تنظیمات", callback_data: "adm:sys" },
      { text: "👑 پنل مدیریت", callback_data: "adm:home" },
    ],
  ],
});

// ارسال پیام خوش‌آمدگویی به گروه
const sendWelcomeMessage = async (bot) => {
  try {
    const message = `🏠 <b>خوش آمدید به گروه مدیریت</b>

🔧 <b>دسترسی‌های موجود:</b>
• 🔍 اسکن ولت TRX
• 📊 مشاهده وضعیت سیستم
• 📋 مدیریت سفارشات
• 💰 گزارش‌های مالی
• ⚙️ تنظیمات سیستم

💡 <b>راهنما:</b>
برای استفاده از منو، روی دکمه‌های زیر کلیک کنید.`;

    // Clear the old persistent group keyboard once, then show the inline menu.
    await hideKeyboard(bot, process.env.GROUP_ID);
    await sendToAdminGroup(bot, message, getGroupKeyboard());
  } catch (error) {
    console.error("❌ Error sending welcome message:", error.message);
  }
};

// مدیریت پیام‌های گروه
const handleGroupMessage = async (bot, msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;

  // فقط ادمین‌های مجاز در گروه ادمین (fail-closed)
  if (!isAdmin(chatId, userId)) {
    return;
  }

  switch (text) {
    case "/admin":
    case "/panel":
    case "پنل": {
      // 👑 SWIFT ADMIN — the full inline panel (same backend as the web
      // dashboard). The legacy group tools remain available via their text
      // commands and the "admin_*" callbacks below.
      await handleAdminPanelCommand(bot, msg);
      break;
    }
    case "🔍 اسکن ولت TRX":
      await handleTrxScan(bot, msg);
      break;
    case "📊 وضعیت سیستم":
      await handleSystemStatus(bot, msg);
      break;
    case "📋 سفارشات جدید":
      await handleNewOrders(bot, msg);
      break;
    case "💰 گزارش مالی":
      await handleFinancialReport(bot, msg);
      break;
    case "⚙️ تنظیمات":
      await handleSettings(bot, msg);
      break;
    case "🆘 پشتیبانی":
      await handleSupport(bot, msg);
      break;
    default:
      // پیام‌های عادی را نادیده بگیر
      break;
  }
};

// اسکن دستی ولت TRX
const handleTrxScan = async (bot, msg) => {
  const chatId = msg.chat.id;
  let scanningMsg;

  try {
    // ارسال پیام در حال اسکن
    scanningMsg = await bot.sendMessage(
      chatId,
      "🔍 در حال اسکن ولت TRX...\n\n⏳ لطفاً صبر کنید..."
    );

    // اجرای اسکن دستی
    await trxScanner.manualScan();

    // ویرایش پیام «در حال اسکن» به نتیجه، به‌جای ارسال پیام جدید
    await bot.editMessageText(
      "✅ اسکن ولت TRX با موفقیت انجام شد!\n\n📊 نتایج در console نمایش داده می‌شود.",
      { chat_id: chatId, message_id: scanningMsg?.message_id }
    ).catch(() => bot.sendMessage(chatId, "✅ اسکن ولت TRX با موفقیت انجام شد!\n\n📊 نتایج در console نمایش داده می‌شود."));
  } catch (error) {
    console.error("❌ Error in TRX wallet scan:", error.message);

    await bot.editMessageText(
      `❌ خطا در اسکن ولت TRX:\n\n${error.message}`,
      { chat_id: chatId, message_id: scanningMsg?.message_id }
    ).catch(() => bot.sendMessage(chatId, `❌ خطا در اسکن ولت TRX:\n\n${error.message}`));
  }
};

// وضعیت سیستم
const handleSystemStatus = async (bot, msg) => {
  const chatId = msg.chat.id;

  const message = `📊 <b>وضعیت سیستم</b>

🟢 <b>وضعیت کلی:</b> فعال
🤖 <b>بات:</b> آنلاین
💾 <b>دیتابیس:</b> متصل
🔍 <b>اسکنر TRX:</b> فعال

⏰ <b>آخرین به‌روزرسانی:</b> ${new Date().toLocaleString("fa-IR")}`;

  try {
    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("❌ Error sending system status:", error.message);
  }
};

// سفارشات جدید
const handleNewOrders = async (bot, msg) => {
  const chatId = msg.chat.id;

  const message = `📋 <b>سفارشات جدید</b>

🔍 برای مشاهده سفارشات جدید، از پنل ادمین استفاده کنید.

💡 <b>راهنما:</b>
دستور /panel را در چت خصوصی با بات ارسال کنید.`;

  try {
    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("❌ Error sending new orders message:", error.message);
  }
};

// گزارش مالی (ساده)
const handleFinancialReport = async (bot, msg) => {
  const chatId = msg.chat.id;

  try {
    const [crypto, bank, totalBalances] = await Promise.all([
      sumAmount(CryptoInvoice, { status: "paid" }),
      sumAmount(bankInvoice, { status: { $in: ["paid", "confirmed"] } }),
      sumUserBalances(),
    ]);
    const totalTopups = crypto.total + bank.total;
    const recognizedRevenue = Math.max(0, totalTopups - totalBalances);
    const { estGigSold, estDaysSold } = estimateCatalogConsumption(recognizedRevenue, [
      ...plans30,
      ...plans60,
      ...plans90,
    ]);

    // هزینه‌ها بر اساس ثابت‌ها
    const costPerDay = Number(process.env.COST_PER_DAY || 200);
    const costPerGb = Number(process.env.COST_PER_GB || 300);
    const totalCost = estDaysSold * costPerDay + estGigSold * costPerGb;
    const profit = recognizedRevenue - totalCost;

    const message =
      `💰 <b>گزارش مالی</b>\n\n` +
      `💵 مجموع شارژهای تایید شده: <code>${totalTopups.toLocaleString()}</code> تومان\n` +
      `👛 مجموع موجودی فعلی کاربران: <code>${totalBalances.toLocaleString()}</code> تومان\n` +
      `📈 سود: <code>${profit.toLocaleString()}</code> تومان`;

    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("❌ Error sending financial report:", error.message);
  }
};

// تنظیمات
const handleSettings = async (bot, msg) => {
  const chatId = msg.chat.id;

  const message = `⚙️ <b>تنظیمات سیستم</b>

🔧 <b>تنظیمات موجود:</b>
• فاصله اسکن خودکار: 5 دقیقه
• حالت تست: غیرفعال
• اعلان‌ها: فعال

💡 <b>راهنما:</b>
برای تغییر تنظیمات، از پنل ادمین استفاده کنید.`;

  try {
    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("❌ Error sending settings message:", error.message);
  }
};

// پشتیبانی
const handleSupport = async (bot, msg) => {
  const chatId = msg.chat.id;

  const message = `🆘 <b>پشتیبانی</b>

📞 <b>راه‌های ارتباطی:</b>
• تلگرام: @Swift_servicebot
• ایمیل: support@example.com

🕐 <b>ساعات کاری:</b>
شنبه تا چهارشنبه: 9 صبح تا 6 عصر

💡 <b>برای کمک فوری:</b>
مشکل خود را در این گروه مطرح کنید.`;

  try {
    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("❌ Error sending support message:", error.message);
  }
};

export {
  sendToAdminGroup,
  getGroupKeyboard,
  sendWelcomeMessage,
  handleGroupMessage,
};
