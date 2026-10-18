import { parseTopUpAmount } from "./validationAmount.js";

// Legacy TRX entry uses the same parser as HooshPay and NOWPayments.
// A valid amount is never rejected for missing commas.
const validateWithCommasTrx = (text, min = 10000, max = 50000000) => parseTopUpAmount(text, min, max);

export default validateWithCommasTrx;
