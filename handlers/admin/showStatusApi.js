import { StatusApi } from "../../api/wizardApi.js";
import { isAdmin, isAdminGroup } from "../../utils/auth.js";

const showStatusApi = async (bot, msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // فقط در گروه ادمین
  if (!isAdminGroup(chatId)) {
    await bot.sendMessage(
      chatId,
      "⛔️ این دستور فقط در گروه ادمین قابل استفاده است."
    );
    return;
  }
  if (!isAdmin(chatId, userId)) {
    await bot.sendMessage(
      chatId,
      "⛔️ فقط ادمین‌ ها به این دستور دسترسی دارند."
    );
    return;
  }
  try {
    const statusData = await StatusApi();

    if (statusData.ok) {
      const result = statusData.result;
      const statusMessage = `📊 وضعیت API

💰 موجودی: <code>${result.balance} تومان</code>
📦 کل سرویس‌ها: <code>${result.count_services}</code>
✅ سرویس‌های فعال: <code>${result.count_active_services}</code>
💾 قیمت هر گیگ: <code>${result.per_gb} تومان</code>
📅 قیمت هر روز: <code>${result.per_day} تومان</code>
🔗 وضعیت سیستم: <code>${
        result.system === "connected" ? "🟢 متصل" : "🔴 قطع"
      }</code>
⚡ پینگ: <code>${result.ping}ms</code>

🕐 آخرین بروزرسانی: <code>${new Date().toLocaleString("fa-IR")}</code>`;

      await bot.sendMessage(chatId, statusMessage, {
        parse_mode: "HTML",
      });
    } else {
      await bot.sendMessage(
        chatId,
        `❌ خطا در دریافت وضعیت: ${statusData.error || "خطای نامشخص"}`
      );
    }
  } catch (error) {
    console.error("❌ Error in /status command:", error);
    await bot.sendMessage(chatId, "❌ خطا در دریافت وضعیت سیستم");
  }
};
export default showStatusApi;
