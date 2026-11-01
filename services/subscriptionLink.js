/**
 * The link a customer imports into their VPN app.
 *
 * The document says of `sub_link`: this is the one to give the customer. Links built from `hash` on a fixed host predate that
 * field and do not follow the service: `change_link` issues a new hash, so a record that kept the old one keeps building a dead
 * link. The built form stays only as the fallback for records with no stored `sub_link`.
 */
const LEGACY_HASH_LINK = "https://iranisystem.com/bot/sub/?hash=";
const HASH = /^[A-Za-z0-9_-]{1,256}$/;

export function validSubscriptionLink(value) {
  if (typeof value !== "string" || value.length < 9 || value.length > 4096 || !/^https:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? value : null;
  } catch {
    return null;
  }
}

export function subscriptionLink({ link, hash } = {}) {
  const direct = validSubscriptionLink(link);
  if (direct) return direct;
  return typeof hash === "string" && HASH.test(hash) ? `${LEGACY_HASH_LINK}${encodeURIComponent(hash)}` : null;
}
