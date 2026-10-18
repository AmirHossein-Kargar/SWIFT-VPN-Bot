import crypto from "node:crypto";

/**
 * IPN signature from the official NOWPayments Node example:
 * https://nowpayments.zendesk.com/hc/en-us/articles/21395546303389-IPN-and-how-to-setup
 *
 * HMAC-SHA512 of JSON.stringify(sortObject(payload)) using the IPN secret.
 * The published Node sample recurses into every object, which also turns arrays
 * into objects. The published PHP/Python samples keep arrays as arrays. The
 * same page also shows a top-level key sort. All three documented forms are
 * checked. A forged body still cannot pass without the IPN secret.
 */
function sortNodeSample(value) {
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    const child = value[key];
    result[key] = child && typeof child === "object" ? sortNodeSample(child) : child;
    return result;
  }, {});
}

function sortPreservingArrays(value) {
  if (Array.isArray(value)) return value.map(sortPreservingArrays);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = sortPreservingArrays(value[key]);
    return result;
  }, {});
}

export function canonicalIpnBodies(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("NOWPayments IPN payload must be a JSON object");
  }
  return [
    JSON.stringify(sortPreservingArrays(payload)),
    JSON.stringify(sortNodeSample(payload)),
    JSON.stringify(payload, Object.keys(payload).sort()),
  ];
}

export function signNowPaymentsIpn(payload, secret, { arrayMode = "preserve" } = {}) {
  if (typeof secret !== "string" || secret.length === 0) throw new TypeError("IPN secret is required");
  const [preserved, nodeSample] = canonicalIpnBodies(payload);
  const body = arrayMode === "node" ? nodeSample : preserved;
  return crypto.createHmac("sha512", secret).update(body, "utf8").digest("hex");
}

export function verifyNowPaymentsSignature(payload, signature, secret) {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof signature !== "string" || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  let bodies;
  try {
    bodies = canonicalIpnBodies(payload);
  } catch {
    return false;
  }
  const received = Buffer.from(signature, "hex");
  return bodies.some((body) => {
    const expected = crypto.createHmac("sha512", secret).update(body, "utf8").digest();
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });
}
