/**
 * HooshPay webhook signature verification.
 *
 * Extracted into its own module so the exact production implementation can be
 * unit-tested directly (rather than a re-implementation in the test file).
 *
 * Per the official HooshPay documentation the signature is computed over the
 * JSON payload with keys sorted alphabetically (PHP `ksort`), re-serialised
 * with compact separators and no ASCII escaping, then HMAC-SHA256'd:
 *
 *   ksort($payload);
 *   $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
 *   $sig  = hash_hmac('sha256', $body, $secret);
 *
 * In Node, `JSON.stringify` with default separators (",", ":") and the default
 * (non-ASCII-escaping) behaviour reproduces that byte-for-byte.
 */
import crypto from "node:crypto";

/**
 * Recursively sort object keys so nested objects are canonicalised too.
 * Arrays keep their order (only object keys are sorted).
 *
 * @param {*} value
 * @returns {*}
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Build the canonical string that HooshPay signs.
 *
 * @param {object} payload - parsed JSON body
 * @returns {string}
 */
export function canonicalPayload(payload) {
  return JSON.stringify(sortKeysDeep(payload));
}

/**
 * Verify a HooshPay webhook signature.
 *
 * @param {object} payload   - parsed JSON body
 * @param {string} signature - hex HMAC-SHA256 from the X-HooshPay-Signature header
 * @param {string} secret    - webhook secret
 * @returns {boolean} true only when the signature is present, well-formed and matches
 */
export function verifyHooshPaySignature(payload, signature, secret) {
  if (!secret || typeof secret !== "string") return false;
  if (!signature || typeof signature !== "string") return false;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  let expectedSig;
  try {
    expectedSig = crypto
      .createHmac("sha256", secret)
      .update(canonicalPayload(payload))
      .digest("hex");
  } catch {
    return false;
  }

  // Reject anything that is not pure hex before decoding — Buffer.from(..,"hex")
  // silently truncates on invalid input, which would weaken the comparison.
  if (!/^[0-9a-f]+$/i.test(signature)) return false;

  const receivedBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");

  // timingSafeEqual throws on length mismatch, so guard first.
  if (receivedBuf.length !== expectedBuf.length) return false;

  try {
    return crypto.timingSafeEqual(receivedBuf, expectedBuf);
  } catch {
    return false;
  }
}

export default { verifyHooshPaySignature, canonicalPayload };
