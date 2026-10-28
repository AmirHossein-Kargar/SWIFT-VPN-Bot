/**
 * Static source checks for services/manualFulfillment.js (Task 5 audit, Bug 1).
 *
 * The module is not part of a release yet, so these checks live apart from the
 * committed regression suite and travel with the module. Commit this file
 * together with services/manualFulfillment.js when the feature is finished.
 *
 *   - approveManualFulfillment queries WalletPurchase with { _id: purchaseId }
 *     but purchaseId is a UUID string (not a MongoDB ObjectId). The filter must
 *     use { purchaseId: purchaseId }.
 *   - cancelManualFulfillment calls runAuditedAction with no `execute` function,
 *     which throws a TypeError before any DB operations.
 *   - commitManualService has the same runAuditedAction problem.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSrc(rel) {
  return readFileSync(join(root, rel), "utf8");
}

describe("manualFulfillment.js — static source checks", () => {
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
