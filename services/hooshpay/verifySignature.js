import crypto from "node:crypto";

/**
 * HooshPay documents sorting the top-level associative-array keys with ksort()
 * before compact JSON encoding. Nested objects retain their received key order;
 * arrays always retain order. This mirrors that PHP contract exactly.
 */
export function canonicalPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Webhook payload must be a JSON object");
  }
  const sorted = Object.create(null);
  for (const key of Object.keys(payload).sort()) {
    Object.defineProperty(sorted, key, {
      value: payload[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return JSON.stringify(sorted);
}

export function verifyHooshPaySignature(payload, signature, secret) {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) return false;

  let expected;
  try {
    expected = crypto.createHmac("sha256", secret).update(canonicalPayload(payload), "utf8").digest();
  } catch {
    return false;
  }
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

export default { verifyHooshPaySignature, canonicalPayload };
