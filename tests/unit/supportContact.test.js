/**
 * Support contact configuration (messages/supportContact.js).
 *
 * Requirement: the support identifier must come from the environment — never
 * hardcoded — and when it is absent the direct-contact UI must disappear
 * instead of pointing users at an arbitrary account. All user-facing strings
 * are Persian.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const {
  getSupportContact,
  getSupportContactUrl,
  getSupportMessage,
  getNewTicketMessage,
  getUnsupportedMediaMessage,
  getSupportTermsUrl,
  getSupportTermsButton,
  getSupportDirectButton,
} = await import("../../messages/supportContact.js");
const { SUPPORT_COPY } = await import("../../messages/supportCopy.js");

const ENV_KEYS = ["SUPPORT_CONTACT", "SUPPORT_TERMS_URL"];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("getSupportContact", () => {
  test("unset / blank → null (nothing hardcoded)", () => {
    delete process.env.SUPPORT_CONTACT;
    assert.equal(getSupportContact(), null);
    process.env.SUPPORT_CONTACT = "   ";
    assert.equal(getSupportContact(), null);
  });

  test("accepts @username and bare username (normalized with @)", () => {
    process.env.SUPPORT_CONTACT = "@swift_support";
    assert.equal(getSupportContact(), "@swift_support");
    process.env.SUPPORT_CONTACT = "swift_support";
    assert.equal(getSupportContact(), "@swift_support");
  });

  test("accepts a numeric Telegram ID verbatim", () => {
    process.env.SUPPORT_CONTACT = "123456789";
    assert.equal(getSupportContact(), "123456789");
  });

  test("rejects malformed values instead of guessing", () => {
    for (const bad of ["@ab", "not a contact!!", "-12345", "@toolongusernamethatexceeds32chars", "09121234567", "@with space"]) {
      process.env.SUPPORT_CONTACT = bad;
      assert.equal(getSupportContact(), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("getSupportContactUrl", () => {
  test("builds a t.me link for username and numeric IDs", () => {
    process.env.SUPPORT_CONTACT = "@swift_support";
    assert.equal(getSupportContactUrl(), "https://t.me/swift_support");
    process.env.SUPPORT_CONTACT = "123456789";
    assert.equal(getSupportContactUrl(), "https://t.me/123456789");
  });

  test("null when unconfigured", () => {
    assert.equal(getSupportContactUrl(), null);
  });
});

describe("getSupportMessage", () => {
  test("is the approved title and description; direct contact is a button, never inline text", () => {
    process.env.SUPPORT_CONTACT = "@swift_support";
    const withContact = getSupportMessage();
    assert.equal(withContact, `<b>${SUPPORT_COPY.title}</b>

${SUPPORT_COPY.description}`);
    assert.doesNotMatch(withContact, /@swift_support|t.me/);
    delete process.env.SUPPORT_CONTACT;
    assert.equal(getSupportMessage(), withContact, "the text does not depend on configuration");
  });

  test("the new-ticket prompt carries the terms notice, the instruction and the supported file types", () => {
    const text = getNewTicketMessage();
    for (const line of [SUPPORT_COPY.termsNotice, SUPPORT_COPY.newTicketPrompt, SUPPORT_COPY.allowedFiles]) assert.ok(text.includes(line));
    assert.doesNotMatch(text, /[A-Za-z]{4,}/, "Persian end-to-end (no English UI fragments)");
  });

  test("the unsupported-media notice lists the allowed types", () => {
    assert.ok(getUnsupportedMediaMessage().includes(SUPPORT_COPY.allowedFiles));
  });
});

describe("getSupportTermsUrl / button", () => {
  test("only an https URL is used; nothing is invented when unset or malformed", () => {
    delete process.env.SUPPORT_TERMS_URL;
    assert.equal(getSupportTermsUrl(), null);
    assert.deepEqual(getSupportTermsButton(), []);
    for (const bad of ["http://example.test/terms", "ftp://x/y", "javascript:alert(1)", "terms", "   "]) {
      process.env.SUPPORT_TERMS_URL = bad;
      assert.equal(getSupportTermsUrl(), null, bad);
    }
    process.env.SUPPORT_TERMS_URL = "https://example.test/terms";
    assert.equal(getSupportTermsUrl(), "https://example.test/terms");
    assert.deepEqual(getSupportTermsButton(), [[{ text: SUPPORT_COPY.terms, url: "https://example.test/terms" }]]);
    delete process.env.SUPPORT_TERMS_URL;
  });
});

describe("getSupportDirectButton", () => {
  test("returns a single Persian inline row with the t.me URL when configured", () => {
    process.env.SUPPORT_CONTACT = "@swift_support";
    const rows = getSupportDirectButton();
    assert.equal(rows.length, 1);
    const button = rows[0][0];
    assert.equal(button.text, SUPPORT_COPY.directContact);
    assert.equal(button.text, "ارتباط مستقیم با پشتیبانی");
    assert.equal(button.url, "https://t.me/swift_support");
  });

  test("returns no rows when unconfigured", () => {
    assert.deepEqual(getSupportDirectButton(), []);
  });
});
