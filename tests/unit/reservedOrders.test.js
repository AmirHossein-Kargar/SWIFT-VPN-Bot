import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";
import { makeBotStub } from "../helpers/db.js";
import { purchasePlan } from "../../services/buyService/purchaseService.js";
import { isAllowedWalletPurchaseTransition } from "../../models/WalletPurchase.js";
import {
  notifyReservedOrder,
  retryPendingReservedAlerts,
  reservedOrderKeyboard,
  reservedOrderText,
} from "../../services/buyService/reservedAlerts.js";
import { approveReservedOrder, cancelReservedOrder } from "../../services/buyService/reservedFulfillment.js";
import { handleReservedOrderCallback } from "../../handlers/reservedOrderCallbacks.js";
import generatePlanButtons, { formatPlanButtonText } from "../../keyboards/generatePlanButtons.js";
import { buildDurationPlansMessage, buildDurationSelectionMarkup } from "../../services/buyService/buyService.js";
import { getCustomerPlans } from "../../services/plans.js";

const ADMIN = 9001;
const GROUP = -100123456;
const PLAN_PRICE = 25_000; // customer plan "mini"

let savedEnv;
before(() => {
  savedEnv = { ADMINS: process.env.ADMINS, GROUP_ID: process.env.GROUP_ID };
  process.env.ADMINS = String(ADMIN);
  process.env.GROUP_ID = String(GROUP);
});
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const providerOk = {
  ok: true,
  result: { username: "svc_reserved_1", hash: "hash_reserved-1", sub_link: "https://panel.example.test/sub/x", tak_links: [] },
};

function shortage() {
  return Object.assign(new Error("hidden supplier detail"), { code: "provider_insufficient_balance", ambiguous: false });
}

/** Fake provider whose wallet can be funded; counts create calls. */
function makeProvider({ funded = false } = {}) {
  const state = { funded, calls: 0, mode: "normal" };
  state.createService = async () => {
    state.calls += 1;
    if (state.mode === "timeout") throw Object.assign(new Error("timeout"), { code: "ECONNABORTED", ambiguous: true });
    if (!state.funded) throw shortage();
    return providerOk;
  };
  return state;
}

async function parkedOrder({ purchaseId = "ord-1", telegramId = "7100", balance = 50_000, provider } = {}) {
  const models = makeFakeWalletModels([{ telegramId, balance }]);
  const prov = provider || makeProvider();
  const result = await purchasePlan(telegramId, "mini", {
    purchaseId,
    userModel: models.userModel,
    purchaseModel: models.purchaseModel,
    createService: prov.createService,
  });
  const order = models.purchases.get(purchaseId);
  return { models, prov, result, order, ref: order._id };
}

function deps(models, prov, extra = {}) {
  const delivered = [];
  return {
    delivered,
    args: {
      purchaseModel: models.purchaseModel,
      userModel: models.userModel,
      createService: prov.createService,
      deliver: async (purchaseId) => { delivered.push(purchaseId); return true; },
      ...extra,
    },
  };
}

describe("subscription UI", () => {
  test("four duration buttons sit in separate rows, each mapped to its day count, with Back last", () => {
    const rows = buildDurationSelectionMarkup().reply_markup.inline_keyboard;
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.slice(0, 4).map((row) => row.length), [1, 1, 1, 1]);
    assert.deepEqual(rows.slice(0, 4).map((row) => row[0].callback_data), ["duration_30", "duration_90", "duration_180", "duration_365"]);
    assert.match(rows[0][0].text, /یک‌ماهه/);
    assert.match(rows[1][0].text, /سه‌ماهه/);
    assert.match(rows[2][0].text, /شش‌ماهه/);
    assert.match(rows[3][0].text, /یک‌ساله/);
    assert.deepEqual(rows[4], [{ text: "🔙 بازگشت", callback_data: "buy_service_back_to_main" }]);
  });

  test("the plan message shows the selected duration but never the plan list", () => {
    for (const days of [30, 90, 180, 365]) {
      const text = buildDurationPlansMessage(days);
      assert.match(text, new RegExp(`${days} روز`));
      assert.match(text, /از دکمه‌های زیر انتخاب کن/);
      for (const plan of getCustomerPlans({ durationDays: days })) {
        assert.equal(text.includes(plan.price.toLocaleString("en-US")), false);
        assert.equal(text.includes(`${plan.gig} گیگابایت`), false);
      }
    }
  });

  test("plan buttons read volume then price, left-to-right isolated, and keep Back last", () => {
    const plans = getCustomerPlans({ durationDays: 30 });
    const rows = generatePlanButtons(plans).reply_markup.inline_keyboard;
    assert.equal(rows.length, plans.length + 1);
    assert.deepEqual(rows.at(-1), [{ text: "🔙 بازگشت", callback_data: "buy_service_back" }]);
    plans.forEach((plan, index) => {
      const text = rows[index][0].text;
      assert.equal(text, `⁦🔹 ${plan.gig} GB | ${plan.price.toLocaleString("en-US")} تومان⁩`);
      assert.ok(text.startsWith("⁦") && text.endsWith("⁩"), "balanced LRI/PDI isolate");
      const volumeAt = text.indexOf(`${plan.gig} GB`);
      const dividerAt = text.indexOf("|");
      const priceAt = text.indexOf(plan.price.toLocaleString("en-US"));
      assert.ok(volumeAt >= 0 && volumeAt < dividerAt && dividerAt < priceAt, "volume, divider, price in that order");
      assert.ok(priceAt < text.indexOf("تومان"), "currency label follows the price");
    });
    assert.equal(formatPlanButtonText({ name: "Custom", gig: "x", price: 1000 }), "⁦Custom | 1,000 تومان⁩");
  });
});

describe("reserved order lifecycle", () => {
  test("provider shortage persists a reserved order, debits once, and flags the admin alert", async () => {
    const { models, result, order } = await parkedOrder();
    assert.equal(result.status, "awaiting_provider");
    assert.equal(order.status, "awaiting_provider");
    assert.equal(order.amount, PLAN_PRICE);
    assert.equal(models.users.get("7100").balance, 50_000 - PLAN_PRICE);
    assert.deepEqual(models.users.get("7100").appliedPurchaseReservations, ["ord-1"]);
    assert.equal(order.walletDebitStatus, "reserved");
    assert.equal(order.adminAlertPending, true);
    assert.equal(order.service, undefined);
    assert.equal(order.serviceLink ?? null, null, "no link before provider success");
  });

  test("the admin alert carries the order facts and the three actions, and no secrets", async () => {
    const { models, order } = await parkedOrder();
    const bot = makeBotStub();
    assert.equal(await notifyReservedOrder(bot, "ord-1", { purchaseModel: models.purchaseModel }), true);
    const sent = bot.sent.find((entry) => entry.kind === "message");
    assert.equal(String(sent.chatId), String(GROUP));
    assert.match(sent.text, /سفارش رزروشده/);
    assert.match(sent.text, /ord-1/);
    assert.match(sent.text, /7100/);
    assert.match(sent.text, /25,000 تومان/);
    assert.match(sent.text, /در انتظار تأمین موجودی WizardXray/);
    const buttons = sent.opts.reply_markup.inline_keyboard.flat();
    assert.deepEqual(buttons.map((b) => b.text), ["✅ تأیید و ایجاد سرویس", "🔄 بررسی مجدد وضعیت", "❌ لغو سفارش"]);
    for (const button of buttons) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    assert.equal(models.purchases.get("ord-1").adminAlertPending, false);
    assert.equal(models.purchases.get("ord-1").adminAlertMessageId, 1);
    // A second notification attempt is a no-op: no duplicate message.
    assert.equal(await notifyReservedOrder(bot, "ord-1", { purchaseModel: models.purchaseModel }), false);
    assert.equal(bot.sent.filter((entry) => entry.kind === "message").length, 1);
    assert.equal(reservedOrderText(order).includes("hash"), false);
  });

  test("a failed admin notification keeps the order and is retried after backoff", async () => {
    const { models } = await parkedOrder();
    const failing = makeBotStub();
    failing.sendMessage = async () => { throw new Error("Bad Request: chat not found"); };
    assert.equal(await notifyReservedOrder(failing, "ord-1", { purchaseModel: models.purchaseModel }), false);
    const order = models.purchases.get("ord-1");
    assert.equal(order.status, "awaiting_provider");
    assert.equal(order.adminAlertPending, true);
    assert.equal(order.adminAlertAttempts, 1);
    assert.ok(order.adminAlertNextAt > new Date());

    const recovered = makeBotStub();
    // Backoff not elapsed: the sweep must not hammer Telegram.
    assert.equal(await retryPendingReservedAlerts(recovered, { purchaseModel: models.purchaseModel }), 0);
    assert.equal(recovered.sent.length, 0);
    // "After restart", once the backoff has elapsed the persisted outbox delivers it.
    const later = new Date(Date.now() + 2 * 60 * 60_000);
    assert.equal(await retryPendingReservedAlerts(recovered, { purchaseModel: models.purchaseModel, now: later }), 1);
    assert.equal(models.purchases.get("ord-1").adminAlertPending, false);
    assert.equal(recovered.sent.filter((entry) => entry.kind === "message").length, 1);
  });

  test("alert retries are bounded", async () => {
    const { models } = await parkedOrder();
    models.purchases.get("ord-1").adminAlertAttempts = 12;
    const bot = makeBotStub();
    assert.equal(await retryPendingReservedAlerts(bot, { purchaseModel: models.purchaseModel, now: new Date(Date.now() + 1e9) }), 0);
    assert.equal(bot.sent.length, 0);
  });

  test("admin approval after funding creates the service once and delivers the real link", async () => {
    const { models, prov, ref, order } = await parkedOrder();
    prov.funded = true;
    const { args, delivered } = deps(models, prov);
    const outcome = await approveReservedOrder({ orderRef: ref, adminId: ADMIN, bot: makeBotStub(), ...args });
    assert.equal(outcome.outcome, "fulfilled");
    assert.equal(outcome.notified, true);
    assert.equal(prov.calls, 2, "one failed shortage attempt, one successful create");
    assert.deepEqual(delivered, ["ord-1"]);
    assert.equal(order.status, "completed");
    assert.equal(order.walletDebitStatus, "finalized");
    assert.equal(order.serviceUsername, "svc_reserved_1");
    assert.equal(order.serviceHash, "hash_reserved-1");
    assert.equal(models.users.get("7100").balance, 50_000 - PLAN_PRICE, "no second debit");
    assert.equal(models.users.get("7100").services.length, 1);
    assert.ok(order.events.some((e) => e.type === "admin_approved"));
  });

  test("approval while the provider is still short returns to awaiting_provider without losing the reservation", async () => {
    const { models, prov, ref, order } = await parkedOrder();
    const { args } = deps(models, prov);
    const first = await approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args });
    assert.equal(first.outcome, "still_short");
    assert.equal(order.status, "awaiting_provider");
    assert.equal(models.users.get("7100").balance, 50_000 - PLAN_PRICE);
    prov.funded = true;
    const second = await approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args });
    assert.equal(second.outcome, "fulfilled");
    assert.equal(models.users.get("7100").services.length, 1);
  });

  test("unauthorized users cannot approve, cancel or view an order", async () => {
    const { models, prov, ref, order } = await parkedOrder();
    prov.funded = true;
    const { args } = deps(models, prov);
    const before = prov.calls;
    for (const intruder of [1234, "abc", null, undefined]) {
      assert.equal((await approveReservedOrder({ orderRef: ref, adminId: intruder, ...args })).outcome, "forbidden");
      assert.equal((await cancelReservedOrder({ orderRef: ref, adminId: intruder, ...args })).outcome, "forbidden");
    }
    assert.equal(prov.calls, before);
    assert.equal(order.status, "awaiting_provider");
  });

  test("duplicate and concurrent approvals share one claim and create exactly one service", async () => {
    const { models, prov, ref } = await parkedOrder();
    prov.funded = true;
    const baseline = prov.calls;
    const { args } = deps(models, prov);
    const outcomes = await Promise.all([
      approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args }),
      approveReservedOrder({ orderRef: ref, adminId: 9002, ...args }),
      approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args }),
    ].map((p) => p.catch((e) => ({ outcome: `threw:${e.message}` }))));
    const fulfilled = outcomes.filter((o) => o.outcome === "fulfilled");
    assert.equal(fulfilled.length, 1);
    assert.equal(prov.calls - baseline, 1);
    assert.equal(models.users.get("7100").services.length, 1);
    assert.equal(models.users.get("7100").balance, 50_000 - PLAN_PRICE);
    // 9002 is not an admin; the other two are not claimable once one wins.
    assert.ok(outcomes.every((o) => ["fulfilled", "not_claimable", "forbidden"].includes(o.outcome)), JSON.stringify(outcomes.map((o) => o.outcome)));
  });

  test("a stale approve on a fulfilled order reports its status and does nothing", async () => {
    const { models, prov, ref } = await parkedOrder();
    prov.funded = true;
    const { args } = deps(models, prov);
    await approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args });
    const calls = prov.calls;
    const stale = await approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args });
    assert.equal(stale.outcome, "not_claimable");
    assert.equal(stale.purchase.status, "completed");
    assert.equal(prov.calls, calls);
    assert.equal(models.users.get("7100").services.length, 1);
  });

  test("an ambiguous provider outcome after approval is held for reconciliation and never replayed", async () => {
    const { models, prov, ref, order } = await parkedOrder();
    prov.mode = "timeout";
    const { args } = deps(models, prov);
    const outcome = await approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args });
    assert.equal(outcome.outcome, "unknown_outcome");
    assert.equal(order.status, "manual_review");
    assert.equal(models.users.get("7100").balance, 50_000 - PLAN_PRICE, "reservation retained");
    const calls = prov.calls;
    prov.mode = "normal";
    prov.funded = true;
    assert.equal((await approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args })).outcome, "not_claimable");
    assert.equal((await cancelReservedOrder({ orderRef: ref, adminId: ADMIN, ...args })).outcome, "not_cancellable");
    assert.equal(prov.calls, calls);
  });

  test("a delivery failure never recreates the service and leaves delivery pending", async () => {
    const { models, prov, ref, order } = await parkedOrder();
    prov.funded = true;
    const { args } = deps(models, prov, { deliver: async () => { throw new Error("Forbidden: bot was blocked by the user"); } });
    const outcome = await approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args });
    assert.equal(outcome.outcome, "fulfilled");
    assert.equal(outcome.notified, false);
    assert.equal(order.status, "completed");
    assert.equal(order.notificationPending, true, "durable outbox keeps the delivery pending");
    const calls = prov.calls;
    assert.equal((await approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args })).outcome, "not_claimable");
    assert.equal(prov.calls, calls);
    assert.match(reservedOrderText(order), /ارسال به کاربر در صف تلاش مجدد/);
  });

  test("a provider create that succeeds with a malformed body is not fulfilled and not delivered", async () => {
    const { models, prov, ref, order } = await parkedOrder();
    const { args, delivered } = deps(models, prov, {
      createService: async () => ({ ok: true, result: { username: "bad name!", hash: "" } }),
    });
    const outcome = await approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args });
    assert.equal(outcome.outcome, "unknown_outcome");
    assert.notEqual(order.status, "completed");
    assert.deepEqual(delivered, []);
    assert.equal(models.users.get("7100").services.length, 0);
  });
});

describe("cancellation and refunds", () => {
  test("cancel refunds exactly once, is idempotent, and notifies the customer", async () => {
    const { models, prov, ref, order } = await parkedOrder();
    const bot = makeBotStub();
    const { args } = deps(models, prov);
    const first = await cancelReservedOrder({ orderRef: ref, adminId: ADMIN, bot, ...args });
    const second = await cancelReservedOrder({ orderRef: ref, adminId: ADMIN, bot, ...args });
    assert.equal(first.outcome, "cancelled");
    assert.equal(second.outcome, "already_cancelled");
    assert.equal(order.status, "refunded");
    assert.equal(order.refundStatus, "completed");
    assert.equal(models.users.get("7100").balance, 50_000);
    assert.deepEqual(models.users.get("7100").refundedPurchaseIds, ["ord-1"]);
    assert.equal(bot.sent.filter((entry) => entry.chatId === "7100").length, 1);
    // A refunded order can no longer be fulfilled.
    prov.funded = true;
    const calls = prov.calls;
    assert.equal((await approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args })).outcome, "not_claimable");
    assert.equal(prov.calls, calls);
  });

  test("cancel and approve race on one atomic state: exactly one wins and money stays consistent", async () => {
    for (const order of [["cancel", "approve"], ["approve", "cancel"]]) {
      const { models, prov, ref } = await parkedOrder();
      prov.funded = true;
      const baseline = prov.calls;
      const { args } = deps(models, prov);
      const actions = { approve: () => approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args }), cancel: () => cancelReservedOrder({ orderRef: ref, adminId: ADMIN, ...args }) };
      const results = await Promise.all(order.map((name) => actions[name]()));
      const approved = results.some((r) => r.outcome === "fulfilled");
      const cancelled = results.some((r) => r.outcome === "cancelled");
      assert.equal(approved !== cancelled, true, "exactly one of approve/cancel wins");
      const user = models.users.get("7100");
      if (approved) {
        assert.equal(user.balance, 50_000 - PLAN_PRICE);
        assert.equal(user.services.length, 1);
        assert.equal(user.refundedPurchaseIds.length, 0);
      } else {
        assert.equal(user.balance, 50_000);
        assert.equal(user.services.length, 0);
        assert.equal(prov.calls, baseline, "no provider spend after a cancellation");
      }
    }
  });

  test("an order that is already being created cannot be cancelled", async () => {
    const { models, prov, ref, order } = await parkedOrder();
    order.status = "provisioning";
    const { args } = deps(models, prov);
    const result = await cancelReservedOrder({ orderRef: ref, adminId: ADMIN, ...args });
    assert.equal(result.outcome, "not_cancellable");
    assert.equal(models.users.get("7100").balance, 50_000 - PLAN_PRICE);
  });

  test("an interrupted admin cancellation resumes without a double credit", async () => {
    const { models, prov, ref, order } = await parkedOrder();
    // Simulate a crash after the refund intent but before the wallet credit.
    order.status = "refund_pending";
    order.refundStatus = "pending";
    order.refundAmount = PLAN_PRICE;
    order.refundReason = "ADMIN_CANCELLED_RESERVED";
    const { args } = deps(models, prov);
    const resumed = await cancelReservedOrder({ orderRef: ref, adminId: ADMIN, ...args });
    await cancelReservedOrder({ orderRef: ref, adminId: ADMIN, ...args });
    assert.equal(resumed.outcome === "cancelled" || resumed.outcome === "already_cancelled", true);
    assert.equal(models.users.get("7100").balance, 50_000);
    assert.deepEqual(models.users.get("7100").refundedPurchaseIds, ["ord-1"]);
  });
});

describe("admin-group callbacks", () => {
  function query(data, { from = ADMIN, chat = GROUP } = {}) {
    return { id: "cb1", data, from: { id: from }, message: { chat: { id: chat }, message_id: 55 } };
  }

  test("a non-admin or a tap outside the admin group is denied before any provider call", async () => {
    const { models, prov, ref } = await parkedOrder();
    prov.funded = true;
    const { args } = deps(models, prov);
    for (const q of [query(`rsv:ok:${ref}`, { from: 1234 }), query(`rsv:ok:${ref}`, { chat: 1234 })]) {
      const bot = makeBotStub();
      assert.equal(await handleReservedOrderCallback(bot, q, args), true);
      assert.ok(bot.sent.some((entry) => entry.kind === "answer" && /دسترسی/.test(entry.opts?.text || "")));
    }
    assert.equal(prov.calls, 1, "only the original shortage attempt");
    assert.equal(models.purchases.get("ord-1").status, "awaiting_provider");
  });

  test("tampered callback data is rejected", async () => {
    const { models, prov } = await parkedOrder();
    const { args } = deps(models, prov);
    for (const data of ["rsv:ok:", "rsv:ok:zzzz", "rsv:ok:../etc", "rsv:xx:" + "a".repeat(24), "rsv:ok:" + "a".repeat(23)]) {
      const bot = makeBotStub();
      assert.equal(await handleReservedOrderCallback(bot, query(data), args), true);
      assert.ok(bot.sent.some((entry) => entry.kind === "answer" && /نامعتبر/.test(entry.opts?.text || "")), data);
    }
    assert.equal(models.purchases.get("ord-1").status, "awaiting_provider");
  });

  test("a missing order answers safely", async () => {
    const { models, prov } = await parkedOrder();
    const { args } = deps(models, prov);
    const bot = makeBotStub();
    await handleReservedOrderCallback(bot, query(`rsv:rf:${"a".repeat(24)}`), args);
    assert.ok(bot.sent.some((entry) => entry.kind === "answer" && /پیدا نشد/.test(entry.opts?.text || "")));
  });

  test("approve via button answers promptly, creates the service, and updates the admin message", async () => {
    const { models, prov, ref, order } = await parkedOrder();
    prov.funded = true;
    const { args } = deps(models, prov);
    const bot = makeBotStub();
    await handleReservedOrderCallback(bot, query(`rsv:ok:${ref}`), args);
    assert.equal(bot.sent[0].kind, "answer", "callback is answered before the provider call");
    assert.equal(order.status, "completed");
    const edit = bot.sent.find((entry) => entry.kind === "edit");
    assert.match(edit.text, /انجام شد/);
    const remaining = edit.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(remaining.every((data) => data.startsWith("rsv:rf:")), "no approve/cancel button after fulfillment");
    // Pressing the same stale button again changes nothing.
    const again = makeBotStub();
    const calls = prov.calls;
    await handleReservedOrderCallback(again, query(`rsv:ok:${ref}`), args);
    assert.equal(prov.calls, calls);
    assert.equal(models.users.get("7100").services.length, 1);
  });

  test("cancel via button needs a confirmation step", async () => {
    const { models, prov, ref, order } = await parkedOrder();
    const { args } = deps(models, prov);
    const bot = makeBotStub();
    await handleReservedOrderCallback(bot, query(`rsv:no:${ref}`), args);
    assert.equal(order.status, "awaiting_provider");
    const confirm = bot.sent.find((entry) => entry.kind === "edit");
    assert.ok(confirm.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `rsv:nc:${ref}`));
    await handleReservedOrderCallback(makeBotStub(), query(`rsv:nc:${ref}`), args);
    assert.equal(order.status, "refunded");
    assert.equal(models.users.get("7100").balance, 50_000);
  });
});

describe("state machine and invariants", () => {
  test("awaiting_provider only exits to provisioning (claim) or refund_pending (cancel)", () => {
    assert.equal(isAllowedWalletPurchaseTransition("provisioning", "awaiting_provider"), true);
    assert.equal(isAllowedWalletPurchaseTransition("awaiting_provider", "provisioning"), true);
    assert.equal(isAllowedWalletPurchaseTransition("awaiting_provider", "refund_pending"), true);
    for (const target of ["completed", "provisioned", "refunded", "failed", "reserved", "manual_review"]) {
      assert.equal(isAllowedWalletPurchaseTransition("awaiting_provider", target), false, target);
    }
    for (const source of ["completed", "refunded", "reserved", "failed"]) {
      assert.equal(isAllowedWalletPurchaseTransition(source, "awaiting_provider"), false, source);
    }
  });

  test("randomized approve/cancel/refresh/funding sequences never double-charge, double-create or double-refund", async () => {
    let seed = 20261027;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let round = 0; round < 60; round += 1) {
      const { models, prov, ref, order } = await parkedOrder({ purchaseId: `prop-${round}`, telegramId: String(7200 + round) });
      const { args } = deps(models, prov);
      const user = models.users.get(String(7200 + round));
      const ops = [];
      for (let i = 0; i < 8; i += 1) {
        const pick = Math.floor(random() * 4);
        if (pick === 0) ops.push(() => { prov.funded = !prov.funded; return Promise.resolve(); });
        else if (pick === 1) ops.push(() => approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args }));
        else if (pick === 2) ops.push(() => cancelReservedOrder({ orderRef: ref, adminId: ADMIN, ...args }));
        else ops.push(() => Promise.all([approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args }), approveReservedOrder({ orderRef: ref, adminId: ADMIN, ...args })]));
      }
      let successfulCreates = 0;
      const originalCreate = prov.createService;
      prov.createService = async (...a) => { const r = await originalCreate(...a); successfulCreates += 1; return r; };
      args.createService = prov.createService;
      for (const op of ops) await op();

      assert.ok(successfulCreates <= 1, "at most one provider service per order");
      assert.ok(user.services.length <= 1);
      const refunded = user.refundedPurchaseIds.length;
      assert.ok(refunded <= 1);
      assert.ok(!(refunded === 1 && user.services.length === 1), "never both refunded and fulfilled");
      const expectedBalance = refunded === 1 ? 50_000 : 50_000 - PLAN_PRICE;
      assert.equal(user.balance, expectedBalance);
      assert.deepEqual(user.appliedPurchaseReservations, [`prop-${round}`]);
      if (order.status === "completed") assert.equal(user.services.length, 1);
    }
  });
});

describe("keyboards", () => {
  test("only an awaiting order exposes approve/cancel; terminal orders expose nothing", () => {
    const base = { _id: "a".repeat(24) };
    assert.equal(reservedOrderKeyboard({ ...base, status: "awaiting_provider" }).inline_keyboard.flat().length, 3);
    assert.deepEqual(reservedOrderKeyboard({ ...base, status: "completed" }).inline_keyboard, []);
    assert.deepEqual(reservedOrderKeyboard({ ...base, status: "refunded" }).inline_keyboard, []);
    const processing = reservedOrderKeyboard({ ...base, status: "manual_review" }).inline_keyboard.flat();
    assert.deepEqual(processing.map((b) => b.callback_data), [`rsv:rf:${"a".repeat(24)}`]);
  });
});
