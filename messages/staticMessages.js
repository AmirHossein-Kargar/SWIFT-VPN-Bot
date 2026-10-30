export const WELCOME_MESSAGE = `🤖 به ربات سویفت خوش آمدید!

🚀 سویفت، شتاب‌دهنده اینترنت شما با لوکیشن‌های مختلف.

📱 قابل استفاده در اندروید، ویندوز، آیفون و سایر دستگاه‌ها.

🌐 قابل استفاده روی اینترنت‌های مختلف.

🔻 از منوی زیر یک گزینه را انتخاب کنید.`;

export const CHOOSE_OPTION_MESSAGE = `🔻لطفا یکی از گزینه های موجود را انتخاب کنید :`;

export const GENERIC_ERROR_MESSAGE = "❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.";

export function getTestServiceMessage({
  maxUser,
  maxUsageMB,
  smartLink,
  singleLink,
  username,
}) {
  return `
   <b>شناسه سرویس:</b> <code>${username}</code>
  👤 <b>حداکثر اتصال:</b> <code>${maxUser} کاربر</code>
  📥 <b>حجم مجاز:</b> <code>${maxUsageMB} گیگابایت</code>
  🔗 <b>لینک هوشمند (همه لوکیشن‌ها):</b>
  <code>${smartLink}</code>
  
  🔗 <b>لینک تکی لوکیشن پیشنهادی:</b>
  <code>${singleLink}</code>
  
  📌 برای کپی لینک، روی آن لمس طولانی کنید یا راست‌کلیک کنید.
  
  ⚠️ این سرویس از نوع <b>Subscription</b> است. جهت اتصال، لطفاً راهنمای استفاده را بررسی کنید.`;
}

export { guideButtons } from "../handlers/message/handleGuide.js";

export function getSuccessServiceMessage({ username, smartLink, singleLink }) {
  return `✅ <b>سرویس شما با موفقیت ساخته شد.</b>

 <b>آیدی سرویس:</b> <code>${username}</code>

🔗 <b>لینک اتصال (Subscription):</b>
<code>${smartLink}</code>

👈 <b>لینک تکی از لوکیشن پیشنهادی:</b>
<code>${singleLink}</code>

📌 برای کپی لینک، روی آن لمس طولانی کنید یا راست‌ کلیک کنید.

⚠️ این سرویس از نوع <b>Subscription</b> است. برای اتصال، از راهنمای زیر استفاده کنید.`;
}
