/**
 * HooshPay webhook over REAL HTTP against the REAL Express app and a REAL MongoDB.
 *
 * Regression coverage for the critical defect where a raw-body middleware ran
 * before express.json(), leaving `req.body` undefined so EVERY webhook was
 * silently discarded.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { waitFor } from "../helpers/util.js";

process.env.HOOSHPAY_WEBHOOK_SECRET = "integration-webhook-secret-for-test-only-0123456789";
process.env.GROUP_ID = ""; // disable Telegram admin alerts

let HooshPayInvoice, User, dbAvailable, server, baseUrl;
const app = (await import("../../server.js")).default;
server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
baseUrl = `http://127.0.0.1:${server.address().port}`;

// Start the real HTTP service before attempting MongoDB. The liveness and
// signature-rejection cases below must remain runnable when the test DB is down.
dbAvailable = await connectTestDB();
if (dbAvailable) {
  ({ default: HooshPayInvoice } = await import("../../models/HooshPayInvoice.js"));
  ({ default: User } = await import("../../models/User.js"));
}

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await disconnectTestDB();
});

const SECRET = process.env.HOOSHPAY_WEBHOOK_SECRET;

function sign(payload) {
  const sorted = {};
  for (const k of Object.keys(payload).sort()) sorted[k] = payload[k];
  return crypto.createHmac("sha256", SECRET).update(JSON.stringify(sorted)).digest("hex");
}

async function postWebhook(body, { signature, raw } = {}) {
  const payloadText = raw ?? JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(payloadText)),
  };
  if (signature !== undefined && signature !== null) headers["X-HooshPay-Signature"] = signature;
  const res = await fetch(`${baseUrl}/api/hooshpay/webhook`, {
    method: "POST",
    headers,
    body: payloadText,
  });
  return res.status;
}

async function seedInvoice({ telegramId, amount = 50000, status = "pending" }) {
  await User.updateOne(
    { telegramId: String(telegramId) },
    { $setOnInsert: { balance: 0 } },
    { upsert: true }
  );
  const uid = `inv_http_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const invoice = await HooshPayInvoice.create({
    uid,
    orderId: `HP-${uid}`,
    userId: Number(telegramId),
    amount,
    paymentUrl: "https://hooshpay.xyz/pay/z",
    status,
  });
  return invoice;
}

const paidPayload = (invoice) => ({
  event: "payment.success",
  invoice: invoice.uid,
  order_id: invoice.orderId,
  status: "paid",
  amount: invoice.amount,
  merchant_credit: invoice.amount,
});

describe("Express endpoints", () => {
  test("/health and /livez return 200 without a database", async () => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.ok(body.ts);

    const live = await fetch(`${baseUrl}/livez`);
    assert.equal(live.status, 200);
  });

  test("/ready reports dependency state without querying MongoDB", async () => {
    const res = await fetch(`${baseUrl}/ready`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ready, false);
    assert.equal(body.dependencies.mongo, dbAvailable);
  });

  test("unsigned and invalid-signature webhooks are rejected before database access", async () => {
    const body = { event: "payment.success", invoice: "inv_http_probe", status: "paid", amount: 10 };
    assert.equal(await postWebhook(body), 401);
    assert.equal(await postWebhook(body, { signature: "0".repeat(64) }), 401);
  });

  test("unknown routes 404", async () => {
    const res = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(res.status, 404);
  });

  test("oversized webhook payload is rejected with 413", async () => {
    const huge = "x".repeat(70 * 1024);
    const status = await postWebhook({}, { raw: huge, signature: "ab" });
    assert.equal(status, 413);
  });

  test("malformed JSON is rejected with 400", async () => {
    const status = await postWebhook({}, { raw: "{not valid json", signature: "ab" });
    assert.equal(status, 400);
  });
});

describe("HooshPay webhook — signature & body handling", () => {
  test("a validly signed webhook is parsed and credited exactly once", { skip: dbAvailable ? false : "MongoDB not reachable" }, async () => {
    const invoice = await seedInvoice({ telegramId: "3001", amount: 50000 });
    const body = paidPayload(invoice);

    const status = await postWebhook(body, { signature: sign(body) });
    assert.equal(status, 200, "webhook always ACKs so the gateway does not retry");

    const credited = await waitFor(async () => {
      const u = await User.findOne({ telegramId: "3001" });
      return u?.balance === 50000 ? u : null;
    });
    assert.ok(credited, "wallet credited — proves req.body was parsed and the signature verified");

    const stored = await HooshPayInvoice.findById(invoice._id);
    assert.equal(stored.status, "paid");
    assert.equal(stored.balanceCredited, true);
  });

  test("a webhook with an invalid signature never credits", { skip: dbAvailable ? false : "MongoDB not reachable" }, async () => {
    const invoice = await seedInvoice({ telegramId: "3002", amount: 60000 });
    const body = paidPayload(invoice);

    await postWebhook(body, { signature: "0".repeat(64) });
    await new Promise((r) => setTimeout(r, 500));

    const user = await User.findOne({ telegramId: "3002" });
    assert.equal(user.balance, 0, "invalid signature => no credit");
  });

  test("a webhook with no signature header never credits", { skip: dbAvailable ? false : "MongoDB not reachable" }, async () => {
    const invoice = await seedInvoice({ telegramId: "3003", amount: 60000 });
    await postWebhook(paidPayload(invoice), {});
    await new Promise((r) => setTimeout(r, 500));

    const user = await User.findOne({ telegramId: "3003" });
    assert.equal(user.balance, 0);
  });

  test("a webhook with a wrong amount never credits", { skip: dbAvailable ? false : "MongoDB not reachable" }, async () => {
    const invoice = await seedInvoice({ telegramId: "3004", amount: 60000 });
    const body = { ...paidPayload(invoice), amount: 1 };

    await postWebhook(body, { signature: sign(body) });
    await new Promise((r) => setTimeout(r, 500));

    const user = await User.findOne({ telegramId: "3004" });
    assert.equal(user.balance, 0, "amount mismatch => no credit");

    const stored = await HooshPayInvoice.findById(invoice._id);
    assert.equal(stored.status, "pending", "invoice left untouched");
  });

  test("an unknown invoice is acknowledged without error", { skip: dbAvailable ? false : "MongoDB not reachable" }, async () => {
    const body = {
      event: "payment.success",
      invoice: "inv_does_not_exist",
      order_id: "HP-nope",
      status: "paid",
      amount: 1000,
    };
    const status = await postWebhook(body, { signature: sign(body) });
    assert.equal(status, 404);
  });

  test("10 CONCURRENT identical webhooks credit exactly once", { skip: dbAvailable ? false : "MongoDB not reachable" }, async () => {
    const invoice = await seedInvoice({ telegramId: "3005", amount: 90000 });
    const body = paidPayload(invoice);
    const sig = sign(body);

    const statuses = await Promise.all(
      Array.from({ length: 10 }, () => postWebhook(body, { signature: sig }))
    );
    assert.ok(statuses.every((s) => s === 200));

    await waitFor(async () => {
      const u = await User.findOne({ telegramId: "3005" });
      return u?.balance === 90000;
    });
    await new Promise((r) => setTimeout(r, 500));

    const user = await User.findOne({ telegramId: "3005" });
    assert.equal(user.balance, 90000, "exactly one credit across 10 concurrent deliveries");
    assert.equal(user.successfulPayments, 1);
  });

  test("a paid webhook for a REVERSED invoice is ignored", { skip: dbAvailable ? false : "MongoDB not reachable" }, async () => {
    const invoice = await seedInvoice({ telegramId: "3006", amount: 70000, status: "paid" });
    await HooshPayInvoice.findByIdAndUpdate(invoice._id, { $set: { status: "reversed" } });

    const body = paidPayload(invoice);
    await postWebhook(body, { signature: sign(body) });
    await new Promise((r) => setTimeout(r, 500));

    const user = await User.findOne({ telegramId: "3006" });
    assert.equal(user.balance, 0, "refunded invoices must never be credited again");
  });

  test("a reversal webhook moves paid -> reversed and never credits", { skip: dbAvailable ? false : "MongoDB not reachable" }, async () => {
    const invoice = await seedInvoice({ telegramId: "3007", amount: 45000, status: "paid" });
    await HooshPayInvoice.findByIdAndUpdate(invoice._id, {
      $set: { fulfilled: true, balanceCredited: true, status: "paid" },
    });

    const body = { event: "payment.reversed", invoice: invoice.uid, status: "reversed" };
    await postWebhook(body, { signature: sign(body) });

    const stored = await waitFor(async () => {
      const i = await HooshPayInvoice.findById(invoice._id);
      return i.status === "reversed" ? i : null;
    });
    assert.ok(stored, "invoice marked reversed");

    const user = await User.findOne({ telegramId: "3007" });
    assert.equal(user.balance, 0, "reversal does not credit");
  });

  test("a late payment on an expired invoice IS credited (funds confirmed by gateway)", { skip: dbAvailable ? false : "MongoDB not reachable" }, async () => {
    const invoice = await seedInvoice({ telegramId: "3008", amount: 20000, status: "expired" });
    const body = paidPayload(invoice);

    await postWebhook(body, { signature: sign(body) });

    const user = await waitFor(async () => {
      const u = await User.findOne({ telegramId: "3008" });
      return u?.balance === 20000 ? u : null;
    });
    assert.ok(user, "gateway-confirmed funds are never silently kept");
  });
});
