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
  getSupportDirectButton,
} = await import("../../messages/supportContact.js");

const ENV_KEYS = ["SUPPORT_CONTACT"];

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
  test("includes the direct-contact block only when configured", () => {
    process.env.SUPPORT_CONTACT = "@swift_support";
    const withContact = getSupportMessage();
    assert.match(withContact, /@swift_support/);
    assert.match(withContact, /ارتباط به صورت مستقیم/);

    delete process.env.SUPPORT_CONTACT;
    const withoutContact = getSupportMessage();
    assert.doesNotMatch(withoutContact, /t\.me/);
    assert.match(withoutContact, /پشتیبانی/);
    assert.match(withoutContact, /قوانین و مقررات/);
  });

  test("message is Persian end-to-end (no English UI fragments)", () => {
    process.env.SUPPORT_CONTACT = "@swift_support";
    const text = getSupportMessage();
    // English UI wording must not leak into the user-facing message (the
    // configured handle itself may legitimately contain latin characters).
    assert.doesNotMatch(text, /before sending|allowed files|support rules|read the rules|please type/i);
    assert.match(text, /پشتیبانی/);
    assert.match(text, /فایل‌های مجاز/);
  });
});

describe("getSupportDirectButton", () => {
  test("returns a single Persian inline row with the t.me URL when configured", () => {
    process.env.SUPPORT_CONTACT = "@swift_support";
    const rows = getSupportDirectButton();
    assert.equal(rows.length, 1);
    const button = rows[0][0];
    assert.equal(button.text, "📩 گفتگو با پشتیبانی");
    assert.equal(button.url, "https://t.me/swift_support");
  });

  test("returns no rows when unconfigured", () => {
    assert.deepEqual(getSupportDirectButton(), []);
  });
});
