export const TOPUP_MIN_TOMAN = 10_000;
export const TOPUP_MAX_TOMAN = 50_000_000;

const PLAIN_INTEGER = /^\d+$/;
const GROUPED_INTEGER = /^\d{1,3}(,\d{3})+$/;
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function invalid(message) {
  return { valid: false, message, parse_mode: "HTML" };
}

function toAsciiDigits(text) {
  return text.replace(/[۰-۹٠-٩]/g, (digit) => {
    const persian = PERSIAN_DIGITS.indexOf(digit);
    if (persian >= 0) return String(persian);
    return String(ARABIC_DIGITS.indexOf(digit));
  });
}

/**
 * Accept a Toman amount with or without thousands separators.
 * `50000`, `50,000`, and Persian/Arabic digits are the same integer.
 * Decimals, signs, and broken separators never become a provider amount.
 */
export function parseTopUpAmount(text, min = 10_000, max = 500_000) {
  if (typeof text !== "string" || text.trim() === "") {
    return invalid("❌ لطفاً مبلغ را به صورت عدد وارد کنید. مثال: <code>50000</code>");
  }
  const trimmed = toAsciiDigits(text.trim()).replace(/[٬،]/g, ",");
  if (trimmed.startsWith("-") || trimmed.startsWith("+") || /[.eE٫]/.test(trimmed)) {
    return invalid("❌ مبلغ باید یک عدد صحیح باشد. اعشار و مقدار منفی پذیرفته نمی‌شود.");
  }
  if (!PLAIN_INTEGER.test(trimmed) && !GROUPED_INTEGER.test(trimmed)) {
    return invalid("❌ مبلغ واردشده معتبر نیست. مثال: <code>50000</code> یا <code>50,000</code>");
  }
  if (trimmed.length > 1 && trimmed.startsWith("0")) {
    return invalid("❌ مبلغ نباید با صفر شروع شود.");
  }

  const amount = Number(trimmed.replaceAll(",", ""));
  if (!Number.isSafeInteger(amount)) {
    return invalid("❌ مبلغ واردشده معتبر نیست.");
  }
  if (amount < min || amount > max) {
    return invalid(`❌ مبلغ باید بین <code>${formatTopUpAmount(min)}</code> تا <code>${formatTopUpAmount(max)}</code> تومان باشد.`);
  }
  return { valid: true, amount };
}

export function formatTopUpAmount(amount) {
  return Number(amount).toLocaleString("en-US");
}

const validateWithCommas = (text, min = 10_000, max = 500_000) => parseTopUpAmount(text, min, max);

export default validateWithCommas;
