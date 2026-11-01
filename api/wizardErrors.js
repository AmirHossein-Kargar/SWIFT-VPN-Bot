/**
 * Every error the WizardXray document lists (section 10 and each method's own list), as data. One table drives the client's
 * classification, docs/wizardxray.md and tests/unit/wizardErrorCatalog.test.js, so the three cannot disagree.
 *
 * The document says the text is fixed and that a client may match it, after checking `http_code` first. So a row matches only
 * on both, and a server-side row also has to name the method it was documented for: `cant update service` from `create` is not
 * a documented answer and stays ambiguous.
 *
 * `code`    what callers branch on (see WIZARD_REJECTION_CODES).
 * `reason`  the specific cause, for messages and telemetry. Stable and free of provider text.
 * `retry`   safe to send the same request again as it is: the document says nothing was charged and nothing changed, and a
 *           later attempt can succeed without anyone doing anything.
 * `outage`  the panel is not doing its job, as opposed to refusing this one request. Counted as a failure by the monitor.
 * `money`   what the document says happened to the charge: "none" (nothing was taken), "refunded" (taken and returned by the
 *           provider), or null where the method costs nothing.
 */
export const REJECTED = "panel_rejected_request";
export const SHORT_OF_FUNDS = "provider_insufficient_balance";
export const BUSY = "provider_busy";
/** A documented server-side failure. The document guarantees the outcome, so unlike any other 5xx it is definite. */
export const OPERATION_FAILED = "panel_operation_failed";

const PAID = ["create", "renew", "upg_time", "upg_size"];
const SERVICE_METHODS = ["info", "find", "renew", "upg_time", "upg_size", "change_link", "reverse_mode", "delsv"];
const ALL = ["*"];

const row = (http, error, code, reason, methods, extra = {}) => Object.freeze({ http, error, code, reason, methods, retry: false, outage: false, money: null, ...extra });

export const WIZARD_ERROR_CATALOG = Object.freeze([
  // Transport and authentication.
  row(400, /^invalid JSON body/, REJECTED, "invalid_json", ALL),
  row(403, "method is invalid", REJECTED, "method_invalid", ALL, { outage: true }),
  row(404, /^method ".*" not found!$/, REJECTED, "method_not_found", ALL, { outage: true }),
  row(403, "not authorized", REJECTED, "auth_missing", ALL, { outage: true }),
  row(403, "apikey is invalid", REJECTED, "auth_invalid", ALL, { outage: true }),
  row(404, "apikey is invalid or not found!", REJECTED, "auth_invalid", ALL, { outage: true }),
  row(403, "API is not available", REJECTED, "api_disabled", ALL, { outage: true, retry: true }),

  // Service identity.
  row(403, "username format is incorrect!", REJECTED, "invalid_username", SERVICE_METHODS),
  row(404, "service not found!", REJECTED, "service_not_found", SERVICE_METHODS),

  // Money and concurrency.
  row(402, "You don't have enough fund!", SHORT_OF_FUNDS, "provider_insufficient_balance", PAID, { money: "none" }),
  row(409, "service is busy, try again", BUSY, "provider_busy", ["create", "renew", "upg_time", "upg_size", "change_link", "reverse_mode", "delsv"], { retry: true, money: "none" }),

  // Terms of create, renew and price.
  row(403, "gig & day is required!", REJECTED, "terms_missing", ["create", "renew", "price"], { money: "none" }),
  row(403, /^Minimum gig: [\d.]+ Minimum day: \d+$/, REJECTED, "terms_below_minimum", ["create", "renew", "price"], { money: "none" }),
  row(403, /^Maximum gig: \d+ Maximum day: \d+$/, REJECTED, "terms_above_maximum", ["create", "renew", "price"], { money: "none" }),
  row(403, /^Minimum day: \d+ Maximum day: \d+$/, REJECTED, "unlimited_days_out_of_range", ["create", "renew", "price"], { money: "none" }),
  row(403, "unlimited is not enabled", REJECTED, "unlimited_disabled", ["create", "renew", "price", "upg_time"], { money: "none" }),

  // create only.
  row(404, "test paramter is required!", REJECTED, "test_param_missing", ["create"], { money: "none" }),
  row(403, "test must be 0 or 1", REJECTED, "test_param_invalid", ["create"], { money: "none" }),
  row(403, /^Maximum test is \d+$/, REJECTED, "test_unavailable", ["create"], { money: "none" }),

  // upg_time and upg_size.
  row(403, "day is required!", REJECTED, "day_missing", ["upg_time"], { money: "none" }),
  row(404, /^Minimum day: \d+$/, REJECTED, "add_day_below_minimum", ["upg_time"], { money: "none" }),
  row(403, /^Maximum day: \d+$/, REJECTED, "add_day_above_maximum", ["upg_time"], { money: "none" }),
  row(403, "gig is required!", REJECTED, "gig_missing", ["upg_size"], { money: "none" }),
  row(404, /^Minimum gig: [\d.]+$/, REJECTED, "add_gig_below_minimum", ["upg_size"], { money: "none" }),
  row(403, /^Maximum gig: \d+$/, REJECTED, "add_gig_above_maximum", ["upg_size"], { money: "none" }),
  row(403, "service is unlimited", REJECTED, "service_is_unlimited", ["upg_size"], { money: "none" }),

  // Others. An empty list and a host failure are answers, handled where they are expected.
  row(403, "status must be active or disabled", REJECTED, "status_invalid", ["reverse_mode"]),
  row(404, "no service", REJECTED, "no_services", ["clients"]),
  row(403, "", REJECTED, "hosts_unavailable", ["get_hosts"], { outage: true }),

  // Server-side, with the outcome the document guarantees.
  row(500, "cant create service", OPERATION_FAILED, "create_failed", ["create"], { outage: true, money: "refunded" }),
  row(500, "cant get info", OPERATION_FAILED, "panel_read_failed", ["renew", "delsv"], { outage: true, retry: true, money: "none" }),
  row(500, "cant get service info", OPERATION_FAILED, "panel_read_failed", ["upg_time", "upg_size", "reverse_mode"], { outage: true, retry: true, money: "none" }),
  row(500, "cant reset usage", OPERATION_FAILED, "update_failed", ["renew"], { outage: true, money: "refunded" }),
  row(500, "cant update service", OPERATION_FAILED, "update_failed", ["renew", "upg_time", "upg_size"], { outage: true, money: "refunded" }),
  row(500, "cant update service", OPERATION_FAILED, "update_failed", ["change_link", "reverse_mode"], { outage: true }),
  row(500, "cant delete service", OPERATION_FAILED, "delete_failed", ["delsv"], { outage: true, money: "none" }),
]);

/** Documented, but carrying no guarantee at all, so it is deliberately absent from the table and stays ambiguous. */
export const UNGUARANTEED_ERRORS = Object.freeze(["internal error"]);

const matches = (expected, text) => (expected instanceof RegExp ? expected.test(text) : expected === text);

/** The catalog row for one refusal, or null. `method` is the path without its slash and query, for example "renew". */
export function findDocumentedError(method, httpCode, error) {
  if (typeof error !== "string") return null;
  return WIZARD_ERROR_CATALOG.find((entry) => entry.http === httpCode
    && (entry.methods === ALL || entry.methods.includes(method))
    && matches(entry.error, error)) ?? null;
}
