/**
 * The provider's convention, in one place: a volume of 0 means unlimited traffic.
 *
 * Only a real zero qualifies. `null` is a record that never had a volume (a test service) and must not read as unlimited, which
 * is why this is not `Number(value) === 0`. Unlimited traffic is not unlimited time: such a service still expires.
 */
export const UNLIMITED_GB = 0;

/**
 * A stored or submitted volume as a number. This is the conversion to use instead of Number(): Number(null), Number("") and
 * Number(false) are all 0, which here is a product, not an absence. Anything that is not a volume is NaN, which no check accepts.
 */
export function volumeNumber(value) {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : Number.NaN;
}

export function isUnlimitedTraffic(value) {
  return value === UNLIMITED_GB || value === "0";
}

/** A positive volume or the unlimited marker. Rejects fractions: catalog volumes are whole gigabytes. */
export function isValidCatalogTraffic(value) {
  return Number.isSafeInteger(value) && value >= UNLIMITED_GB;
}

export function trafficTextFa(gb) {
  if (isUnlimitedTraffic(gb)) return "نامحدود ♾";
  return gb == null ? "نامشخص" : `${gb} گیگابایت`;
}

export function trafficTextEn(gb) {
  if (isUnlimitedTraffic(gb)) return "Unlimited";
  return gb == null ? "—" : `${gb} GB`;
}
