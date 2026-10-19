/* Central number / money / date formatting for the admin dashboard.
 *
 * Source of truth for units: every monetary value in the database and API is an
 * integer amount of TOMAN. Nothing here converts between Rial and Toman and
 * nothing divides by 10; switching language only changes presentation.
 * Machine-readable values (IDs, hashes, API keys) must NOT go through these
 * helpers and are rendered verbatim by the caller.
 *
 * Works in the browser (window.SwiftFormat) and in Node tests (module.exports).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SwiftFormat = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var TIME_ZONE = "Asia/Tehran";
  var PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
  var cache = {};

  function fmt(key, create) { return cache[key] || (cache[key] = create()); }
  function locale(lang) { return lang === "fa" ? "fa-IR" : "en-US"; }
  function valid(value) { return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)); }

  function toPersianDigits(text) {
    return String(text).replace(/\d/g, function (d) { return PERSIAN_DIGITS[Number(d)]; });
  }

  function number(value, lang, options) {
    if (!valid(value)) return "—";
    var key = "n|" + lang + "|" + JSON.stringify(options || {});
    return fmt(key, function () { return new Intl.NumberFormat(locale(lang) + "-u-nu-" + (lang === "fa" ? "arabext" : "latn"), options || {}); }).format(Number(value));
  }

  /** Integer amounts of Toman; rounding is display-only (values are never written back). */
  function money(value, lang) {
    if (!valid(value)) return "—";
    return number(Math.round(Number(value)), lang, { maximumFractionDigits: 0 }) + (lang === "fa" ? " تومان" : " Toman");
  }

  function percent(ratio, lang, digits) {
    if (!valid(ratio)) return "—";
    return number(Number(ratio), lang, { style: "percent", minimumFractionDigits: 0, maximumFractionDigits: digits == null ? 1 : digits });
  }

  /** Compact axis labels: 1.2M / ۱٫۲ میلیون. */
  function compact(value, lang) {
    if (!valid(value)) return "—";
    return number(Number(value), lang, { notation: "compact", maximumFractionDigits: 1 });
  }

  function toDate(value) {
    if (value === null || value === undefined || value === "") return null;
    var d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function dateFormatter(lang, options) {
    var tag = lang === "fa" ? "fa-IR-u-ca-persian-nu-arabext" : "en-GB";
    var key = "d|" + tag + "|" + JSON.stringify(options);
    return fmt(key, function () { return new Intl.DateTimeFormat(tag, Object.assign({ timeZone: TIME_ZONE }, options)); });
  }

  /** Jalali in Persian mode (Asia/Tehran), Gregorian en-GB otherwise. */
  function dateTime(value, lang) {
    var d = toDate(value);
    if (!d) return "—";
    return dateFormatter(lang, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  }
  function date(value, lang) {
    var d = toDate(value);
    if (!d) return "—";
    return dateFormatter(lang, { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
  /** Short axis label such as "۲۸ مهر" or "20 Oct". */
  function dayLabel(value, lang) {
    var d = toDate(value);
    if (!d) return "";
    return dateFormatter(lang, { month: "short", day: "numeric" }).format(d);
  }
  /** Value for <input type=date>: the Tehran calendar day as YYYY-MM-DD (always Gregorian/ASCII). */
  function isoDay(value) {
    var d = toDate(value);
    if (!d) return "";
    var parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    return parts;
  }

  return { TIME_ZONE: TIME_ZONE, toPersianDigits: toPersianDigits, number: number, money: money, percent: percent, compact: compact, dateTime: dateTime, date: date, dayLabel: dayLabel, isoDay: isoDay };
});
