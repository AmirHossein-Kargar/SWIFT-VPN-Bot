const formatPlanButtonText = (plan) => {
  if (Number.isSafeInteger(plan.gig)) {
    return `🔹 ${plan.gig} GB | ${plan.price.toLocaleString("en-US")} تومان`;
  }
  return `${plan.name} | ${plan.price.toLocaleString("en-US")} تومان`;
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