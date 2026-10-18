import crypto from "node:crypto";

/**
 * Canonicalization from NOWPayments' published Node IPN example: recursively
 * sort every object's keys before JSON.stringify. JavaScript arrays are objects
 * in that sample and are therefore emitted as sorted numeric-key objects.
 */
function sortForNowPayments(value) {
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = sortForNowPayments(value[key]);
    return result;
  }, {});
}

export function canonicalIpnBody(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("NOWPayments IPN payload must be a JSON object");
  }
  return JSON.stringify(sortForNowPayments(payload));
}

// Backward-compatible export name for callers that previously iterated forms.
export function canonicalIpnBodies(payload) {
  return [canonicalIpnBody(payload)];
}

export function signNowPaymentsIpn(payload, secret) {
  if (typeof secret !== "string" || secret.length === 0) throw new TypeError("IPN secret is required");
  return crypto.createHmac("sha512", secret).update(canonicalIpnBody(payload), "utf8").digest("hex");
}

export function verifyNowPaymentsSignature(payload, signature, secret) {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof signature !== "string" || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  let expected;
  try {
    expected = crypto.createHmac("sha512", secret).update(canonicalIpnBody(payload), "utf8").digest();
  } catch {
    return false;
  }
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
