const validateWithCommasTrx = (text, min = 10000, max = 50000000) => {
  const commaPattern = /^\d{1,3}(,\d{3})*$/;

  if (!commaPattern.test(text)) {
    return {
      valid: false,
      message:
        "❌ لطفاً مبلغ را به‌درستی و با کاما وارد کنید. مثال: <code>50,000</code> یا <code>120,000</code>",
      parse_mode: "HTML",
    };
  }

  const amount = parseInt(text.replace(/,/g, ""));

  if (!Number.isSafeInteger(amount) || amount < min || amount > max) {
    return {
      valid: false,
      message: `❌ مبلغ باید بین <code>${min.toLocaleString()}</code> تا <code>${max.toLocaleString()}</code> تومان باشد.`,
      parse_mode: "HTML",
    };
  }
  return { valid: true, amount };
};

export default validateWithCommasTrx;
