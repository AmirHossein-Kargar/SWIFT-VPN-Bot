import { isUnlimitedTraffic } from "../utils/serviceTerms.js";

// Left-to-right isolate: Telegram picks a base direction per label, so a Persian "تومان" next to digits could flip the
// visual order. Isolating the whole label pins it to "<volume> | <price>" left to right without affecting other rows.
const LRI = "⁦";
const PDI = "⁩";

export const formatPlanButtonText = (plan) => {
  const price = plan.price.toLocaleString("en-US");
  if (isUnlimitedTraffic(plan.gig)) return `${LRI}♾ نامحدود | ${price} تومان${PDI}`;
  if (Number.isSafeInteger(plan.gig)) {
    return `${LRI}🔹 ${plan.gig} GB | ${price} تومان${PDI}`;
  }
  return `${LRI}${plan.name} | ${price} تومان${PDI}`;
};

const generatePlanButtons = (plans) => {
  const buttons = plans.map((plan) => [
    {
      text: formatPlanButtonText(plan),
      callback_data: `plan_${plan.id}`,
    },
  ]);

  // * Add the "بازگشت" (Back) button at the end
  buttons.push([
    {
      text: "🔙 بازگشت",
      callback_data: "buy_service_back",
    },
  ]);

  return {
    reply_markup: {
      inline_keyboard: buttons,
    },
  };
};

export default generatePlanButtons;