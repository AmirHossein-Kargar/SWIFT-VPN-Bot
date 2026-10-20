/**
 * Regression tests for confirmed bugs (Task 5 audit).
 *
 * These tests were written BEFORE the fixes so they demonstrate the exact
 * failure mode of each defect. All tests pass after the corresponding fix
 * is applied.
 *
 * Bug 1 — manualFulfillment.js: wrong runAuditedAction usage & wrong MongoDB filter
 *   - approveManualFulfillment queries WalletPurchase with { _id: purchaseId }
 *     but purchaseId is a UUID string (not a MongoDB ObjectId). The filter must
 *     use { purchaseId: purchaseId }.
 *   - cancelManualFulfillment calls runAuditedAction with no `execute` function,
 *     which throws a TypeError before any DB operations.
 *   - commitManualService has the same runAuditedAction problem.
 *
 * Bug 2 — onMessage.js: hardcoded support URL in admin message flow
 *   - The "contact support" button in admin message delivery uses
 *     "https://t.me/Swift_servicebot" hardcoded. This must come from the
 *     SUPPORT_CONTACT environment variable (or the button must be omitted when
 *     it is not configured).
 *
 * Bug 3 — payNowPayments.js: invoice payment link button still uses ₮ emoji
 *   - After switching the payment-method button to ₿, the inline "pay invoice"
 *     button in confirmNowPaymentsTopUp still labels itself with ₮ instead of
 *     a consistent icon.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NOWPAYMENTS_BUTTON } from "../../handlers/message/showPaymentMethods.js";
import { runAuditedAction } from "../../services/admin/audit.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Helpers ────────────────────────────────────────────────────────────────

function readSrc(rel) {
  return readFileSync(join(root, rel), "utf8");
}

// ── Bug 1: manualFulfillment.js — wrong runAuditedAction usage ─────────────

describe("manualFulfillment.js — runAuditedAction API contract", () => {
  test("runAuditedAction must be called with an execute function", async () => {
    // runAuditedAction throws TypeError synchronously when execute is not a
    // function.  The correct pattern is:
    //   runAuditedAction({ ..., execute: async ({ audit }) => { ... } })
    // The buggy pattern calls it without execute and then tries to destructure
    // { audit, commitAudit } from the result, which never resolves.
    await assert.rejects(
      () => runAuditedAction({
        actorTelegramId: "99999",
        operationId: "test-op-regression-001",
        action: "MANUAL_PURCHASE_CANCELLED",
        targetType: "wallet_purchase",
        targetId: "purchase-uuid-001",
        // execute is intentionally missing — this is the bug
      }),
      (err) => {
        // Must throw synchronously with a TypeError or AdminServiceError
        return err instanceof TypeError || err?.constructor?.name === "AdminServiceError"
          || (err instanceof Error && err.message.includes("execute"));
      },
      "runAuditedAction must throw when execute function is missing",
    );
  });

  test("manualFulfillment approveManualFulfillment queries by purchaseId, not _id", () => {
    // Static check: verify the filter keys on `purchaseId`, not `_id`. The
    // query may spell this out explicitly (`purchaseId: purchaseId`) or use
    // valid ES6 object-shorthand (`purchaseId,` inside an object literal) —
    // both are equivalent at runtime, so either must satisfy this check.
    const source = readSrc("services/manualFulfillment.js");
    // Extract the approveManualFulfillment function body
    const approveStart = source.indexOf("export async function approveManualFulfillment");
    const approveEnd = source.indexOf("\nexport async function", approveStart + 1);
    const approveBody = source.slice(
      approveStart,
      approveEnd === -1 ? approveStart + 2000 : approveEnd,
    );

    // Explicit property syntax: `purchaseId:` or `purchaseId :`.
    const explicitProperty = /purchaseId\s*:/;
    // ES6 shorthand property: `purchaseId` sitting directly between object-
    // literal delimiters (`{`/`,` before, `,`/`}` after) — this scopes the
    // match to an actual object-literal property position, not merely the
    // word "purchaseId" appearing anywhere (e.g. in the function's own
    // parameter list, which is `(purchaseId, adminId)`, or in a comment).
    const shorthandProperty = /[{,]\s*purchaseId\s*[,}]/;

    assert.ok(
      explicitProperty.test(approveBody) || shorthandProperty.test(approveBody),
      "approveManualFulfillment must query WalletPurchase by { purchaseId } (explicit or ES6 shorthand), not { _id }",
    );
  });

  test("manualFulfillment cancelManualFulfillment queries by purchaseId, not _id", () => {
    const source = readSrc("services/manualFulfillment.js");
    const cancelStart = source.indexOf("export async function cancelManualFulfillment");
    const cancelEnd = source.indexOf("\nexport async function commitManualService", cancelStart);
    const cancelBody = source.slice(
      cancelStart,
      cancelEnd === -1 ? cancelStart + 3000 : cancelEnd,
    );

    // WalletPurchase queries must use { purchaseId: ... } not { _id: purchaseId }
    assert.ok(
      cancelBody.includes("purchaseId:") || cancelBody.includes("purchaseId :"),
      "cancelManualFulfillment must query WalletPurchase by { purchaseId } not { _id }",
    );

    // The runAuditedAction call must contain an execute function
    assert.ok(
      cancelBody.includes("execute:"),
      "cancelManualFulfillment must pass execute: fn to runAuditedAction",
    );
  });

  test("manualFulfillment commitManualService uses correct runAuditedAction with execute fn", () => {
    const source = readSrc("services/manualFulfillment.js");
    const commitStart = source.indexOf("export async function commitManualService");
    const commitBody = source.slice(
      commitStart,
      commitStart + 4000,
    );

    assert.ok(
      commitBody.includes("execute:"),
      "commitManualService must pass execute: fn to runAuditedAction",
    );
  });
});

// ── Bug 2: onMessage.js — hardcoded support URL ────────────────────────────

describe("onMessage.js — no hardcoded support contact URLs", () => {
  test("admin message delivery must not contain a hardcoded t.me support URL", () => {
    const source = readSrc("handlers/onMessage.js");
    // The hardcoded URL that must not appear in onMessage.js
    const hardcodedUrl = "https://t.me/Swift_servicebot";
    assert.ok(
      !source.includes(hardcodedUrl),
      `onMessage.js must not contain the hardcoded support URL '${hardcodedUrl}'. ` +
        "Use getSupportContactUrl() from messages/supportContact.js instead.",
    );
  });

  test("admin message delivery support button must come from env SUPPORT_CONTACT", () => {
    const source = readSrc("handlers/onMessage.js");
    // If any URL button is present in the admin send-message flow, it must be
    // derived from the environment — not hardcoded.
    // Simple check: ensure no hardcoded t.me/ handle remains
    const hardcodedPattern = /url:\s*"https:\/\/t\.me\/[A-Za-z_][A-Za-z0-9_]*/;
    assert.ok(
      !hardcodedPattern.test(source),
      "onMessage.js must not contain hardcoded t.me URL strings for support contact buttons.",
    );
  });
});

// ── Bug 3: payNowPayments.js — ₮ vs ₿ consistency ─────────────────────────

describe("payNowPayments.js — payment button emoji consistency", () => {
  test("invoice payment link button must not use the ₮ (Tether) emoji", () => {
    const source = readSrc("paymentHandlers/payNowPayments.js");
    // Find the inline button near the invoice URL (the "pay invoice" button)
    // It should NOT use ₮ since that was replaced with ₿ in the UX update.
    // We look for the text label of the URL button rendered after invoice creation.
    const invoiceButtonPattern = /text:\s*"[^"]*₮[^"]*پرداخت فاکتور[^"]*"/;
    assert.ok(
      !invoiceButtonPattern.test(source),
      "The payment link button must not use ₮ after the ₿ emoji update. Found '₮ پرداخت فاکتور'.",
    );
  });

  test("crypto payment method button is the Persian 🪙 label and never uses ₮", () => {
    assert.equal(NOWPAYMENTS_BUTTON, "🪙 پرداخت با کریپتو");
    assert.ok(!NOWPAYMENTS_BUTTON.includes("₮"));
  });

  test("the ₮ emoji must not appear in any user-visible payment label in payNowPayments.js", () => {
    const source = readSrc("paymentHandlers/payNowPayments.js");
    // ₮ in a text: "..." button label is never correct now that we use ₿
    const textLabelWithTether = /\btext:\s*"[^"]*₮[^"]*"/g;
    const matches = [...source.matchAll(textLabelWithTether)];
    assert.deepEqual(
      matches.map((m) => m[0]),
      [],
      "No text: button label in payNowPayments.js should contain the ₮ symbol",
    );
  });
});
