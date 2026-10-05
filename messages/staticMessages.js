export const WELCOME_MESSAGE = `🤖 به سویفت خوش آمدید

🚀 سرویس‌های خود را مدیریت کنید، کیف پول را شارژ کنید یا راهنما را ببینید.

📱 سازگار با اندروید، ویندوز و آیفون

👇 برای ادامه یکی از دکمه‌های همین پیام را انتخاب کنید.`;

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
