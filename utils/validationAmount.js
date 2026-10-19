const DEFAULT_TOPUP_MIN_TOMAN = 10_000;
const DEFAULT_TOPUP_MAX_TOMAN = 50_000_000;

function configuredLimit(name, fallback, env) {
  const raw = String(env[name] ?? "").trim();
  if (!/^[1-9]\d{0,15}$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

/**
 * Wallet top-up limits in Toman. Override with TOPUP_MIN_TOMAN / TOPUP_MAX_TOMAN;
 * invalid or inconsistent values fall back to the defaults.
 */
export function resolveTopUpLimits(env = process.env) {
  const min = configuredLimit("TOPUP_MIN_TOMAN", DEFAULT_TOPUP_MIN_TOMAN, env);
  const max = configuredLimit("TOPUP_MAX_TOMAN", DEFAULT_TOPUP_MAX_TOMAN, env);
  return min <= max
    ? { min, max }
    : { min: DEFAULT_TOPUP_MIN_TOMAN, max: DEFAULT_TOPUP_MAX_TOMAN };
}

export const TOPUP_MIN_TOMAN = resolveTopUpLimits().min;
export const TOPUP_MAX_TOMAN = resolveTopUpLimits().max;

const INVISIBLE_MARKS = /[\u200b-\u200f\u202a-\u202e\ufeff]/g;
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
  const trimmed = toAsciiDigits(text).replace(INVISIBLE_MARKS, "").trim().replace(/[٬،，]/g, ",");
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
