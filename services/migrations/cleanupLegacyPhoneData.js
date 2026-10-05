import User from "../../models/User.js";
import bankInvoice from "../../models/invoice.js";
import CryptoInvoice from "../../models/CryptoInvoice.js";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import WalletPurchase from "../../models/WalletPurchase.js";

// User.phoneNumber was the only phone field written by this application. Sweep
// the known user/order/payment collections for plausible legacy aliases too;
// keep payment card numbers and unrelated webhook audit data untouched.
const LEGACY_PHONE_PATHS = [
  "phoneNumber",
  "phone_number",
  "phone",
  "mobile",
  "mobileNumber",
  "mobile_number",
  "telephone",
  "telephoneNumber",
  "telephone_number",
];

const LEGACY_PHONE_FILTER = {
  $or: LEGACY_PHONE_PATHS.map((path) => ({ [path]: { $exists: true } })),
};
const LEGACY_PHONE_UNSET = Object.fromEntries(LEGACY_PHONE_PATHS.map((path) => [path, ""]));
const DATA_MODELS = [User, bankInvoice, CryptoInvoice, HooshPayInvoice, WalletPurchase];

// Current application writes have no embedded phone fields, but these are the
// only known embedded user/payment containers. Scrub aliases there as well for
// older or manually duplicated records without replacing the surrounding data.
const EMBEDDED_PHONE_CONTAINERS = Object.freeze({
  User: { filterPrefix: "services", updatePrefix: "services.$[]" },
  HooshPayInvoice: {
    filterPrefix: "webhookLog.payload",
    updatePrefix: "webhookLog.$[].payload",
  },
});

/**
 * Idempotently remove obsolete phone fields from top-level user/order/payment
 * documents and known embedded service/webhook records. Uses native collection
 * updates because current strict schemas intentionally no longer contain the
 * legacy fields; only matching phone aliases are unset.
 */
export async function cleanupLegacyPhoneData(models = DATA_MODELS) {
  const collections = [];
  for (const model of models) {
    const collection = model.collection.collectionName;
    const topLevel = await model.collection.updateMany(
      LEGACY_PHONE_FILTER,
      { $unset: LEGACY_PHONE_UNSET }
    );
    collections.push({
      collection,
      modifiedCount: Number(topLevel.modifiedCount || 0),
    });

    const embedded = EMBEDDED_PHONE_CONTAINERS[model.modelName];
    if (!embedded) continue;
    const embeddedFilter = {
      $or: LEGACY_PHONE_PATHS.map((path) => ({
        [`${embedded.filterPrefix}.${path}`]: { $exists: true },
      })),
    };
    const embeddedUnset = Object.fromEntries(
      LEGACY_PHONE_PATHS.map((path) => [`${embedded.updatePrefix}.${path}`, ""])
    );
    const nested = await model.collection.updateMany(embeddedFilter, { $unset: embeddedUnset });
    collections.push({
      collection: `${collection}.${embedded.filterPrefix}`,
      modifiedCount: Number(nested.modifiedCount || 0),
    });
  }

  return {
    collections,
    modifiedDocuments: collections.reduce((sum, item) => sum + item.modifiedCount, 0),
  };
}

export { LEGACY_PHONE_PATHS };
export default cleanupLegacyPhoneData;
