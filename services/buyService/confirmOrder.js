import { isUnlimitedTraffic } from "../../utils/serviceTerms.js";

const confirmOrder = (plan) => {
  const durationDisplay = plan.durationLabel
    ? `${plan.durationLabel} (${plan.days} روز)`
    : `${plan.days} روز`;

  const message = `
🛍 <b>آیا خرید سرویس با این مشخصات را تایید میکنید !؟</b>

📅 <b>زمان: </b> <code>${durationDisplay}</code>
<b>حجم سرویس :</b> <code>${isUnlimitedTraffic(plan.gig) ? "نامحدود ♾" : `${plan.gig} گیگ`}</code>
🌐 <b>حداکثر اتصال :</b> <code>نامحدود ♾</code>

💸 <b>قیمت نهایی: </b> <code>${plan.price.toLocaleString("en-US")} تومان</code>

‼️ <a href="https://t.me/swift_shield/4">خرید شما به معنای تایید قوانین و مقررات ماست.</a>
  `.trim();

  const replyMarkup = {
    disable_web_page_preview: true,
    inline_keyboard: [
      [{ text: "✅ تایید سفارش", callback_data: `confirm_order_${plan.id}` }],
      [{ text: "🔙 بازگشت", callback_data: "buy_service_back" }],
    ],
  };
  return { message, replyMarkup };
};

export default confirmOrder;
