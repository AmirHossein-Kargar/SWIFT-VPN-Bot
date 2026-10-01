/**
 * TRXWalletScanner
 * ----------------
 * Polls TronScan for incoming TRX transfers to TRX_WALLET, matches them against
 * unpaid CryptoInvoice documents, and credits the user's wallet.
 *
 * Concurrency & correctness model
 * -------------------------------
 *  • Single-instance: a Redis lock (`trx:scan:cron`, NX + TTL) means only one
 *    worker scans at a time. It fails OPEN when Redis is unavailable — the
 *    in-process `isScanning` guard still protects a single process, and the
 *    atomic MongoDB claims below are the real safety net.
 *
 *  • Exactly-once crediting is enforced by two atomic single-document writes,
 *    NOT by read-then-write:
 *      Phase 1  { _id, status: "unpaid" }                      -> status: "paid"
 *      Phase 2  { _id, status: "paid", balanceCredited: false } -> balanceCredited: true
 *    A duplicate scan (or a second worker) loses the race and does nothing.
 *
 *  • One transaction settles at most one invoice: `transactionHash` is a sparse
 *    unique index, so reusing a hash across invoices raises E11000 and is
 *    treated as "already consumed". The scanner also stops after the first
 *    successful match for a given transaction.
 *
 *  • Crash recovery: an invoice left at { status: "paid", balanceCredited:
 *    false } is completed at the start of the next scan cycle.
 *
 * MongoDB is the authoritative source of financial truth; Redis is only a
 * scheduling optimisation.
 */
import axios from "axios";
import CryptoInvoice from "../models/CryptoInvoice.js";
import { getSession } from "../config/sessionStore.js";
import mongoose from "mongoose";
import redisClient from "../config/redisClient.js";

const TRX_CRON_LOCK_KEY = "trx:scan:cron";
const TRX_CRON_LOCK_TTL = 270; // 4.5 min — just under the 5-min scan interval
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const MATCH_TOLERANCE = 0.01; // 1% — covers rate drift between quote and payment
const RECENT_TX_LIMIT = 20;
const RECOVERY_BATCH_SIZE = 50;

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "trx-scanner", level, message, ...meta })
  );
}

class TRXWalletScanner {
  constructor() {
    this.walletAddress = process.env.TRX_WALLET;
    this.scanInterval = null;
    this.isScanning = false;
    this.botInstance = null;
    this.scanCount = 0;
    this.lastScanTime = null;
    this.startTime = Date.now();
    this.databaseConnected = false;
    this.tronScanConnected = false;
  }

  setBotInstance(bot) {
    this.botInstance = bot;
  }

  // ── Pause/stop controls ────────────────────────────────────────────────────
  pause(client) {
    if (client && client.pause) client.pause();
  }

  resume(client) {
    if (client && client.resume) client.resume();
  }

  // ── Connectivity checks ────────────────────────────────────────────────────
  async checkDatabaseConnection() {
    try {
      this.databaseConnected = mongoose.connection?.readyState === 1;
    } catch {
      this.databaseConnected = false;
    }
    return this.databaseConnected;
  }

  async checkTronScanConnection() {
    try {
      const res = await axios.get(
        `https://apilist.tronscanapi.com/api/account?address=${this.walletAddress}`,
        { timeout: 10000 }
      );
      this.tronScanConnected = res.status === 200;
    } catch {
      this.tronScanConnected = false;
    }
    return this.tronScanConnected;
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────
  startAutoScan() {
    if (this.scanInterval) {
      log("info", "TRX wallet scanner already running");
      return;
    }

    this.scanInterval = setInterval(() => {
      this.scanWallet().catch((e) => log("error", "Unhandled scan error", { error: e.message }));
    }, SCAN_INTERVAL_MS);
    if (this.scanInterval.unref) this.scanInterval.unref();

    // Initial run (not awaited — startAutoScan stays synchronous for callers)
    this.scanWallet().catch((e) => log("error", "Unhandled scan error", { error: e.message }));
  }

  stopAutoScan() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
  }

  // ── Main scan ──────────────────────────────────────────────────────────────
  /**
   * @returns {Promise<object>} summary object (also consumed by the admin panel)
   */
  async scanWallet() {
    const emptySummary = {
      totalTransactions: 0,
      processedTransactions: 0,
      matchedInvoices: 0,
      confirmedInvoices: 0,
      rejectedInvoices: 0,
      pendingMatches: 0,
      recoveredInvoices: 0,
      matchedInvoiceDetails: [],
      recentTransactions: [],
      totalBalance: 0,
    };

    if (this.isScanning) {
      log("info", "Scan already in progress — skipping");
      return emptySummary;
    }
    if (!this.walletAddress) {
      log("error", "TRX_WALLET is not configured — scanner disabled");
      return { ...emptySummary, error: "TRX_WALLET not configured" };
    }

    // Distributed lock — only one instance scans at a time.
    let redisLockAcquired = false;
    try {
      const lockResult = await redisClient.set(TRX_CRON_LOCK_KEY, process.pid.toString(), {
        NX: true,
        EX: TRX_CRON_LOCK_TTL,
      });
      if (lockResult !== "OK") {
        log("info", "Scan lock held by another instance — skipping");
        return emptySummary;
      }
      redisLockAcquired = true;
    } catch (err) {
      // Redis unavailable — fail open; atomic Mongo claims keep us safe.
      log("warn", "Redis lock unavailable (fail-open)", { error: err.message });
    }

    this.isScanning = true;
    this.scanCount += 1;
    this.lastScanTime = Date.now();

    try {
      await this.checkDatabaseConnection();
      await this.checkTronScanConnection();

      if (!this.databaseConnected) {
        log("warn", "Database not connected — aborting scan");
        return emptySummary;
      }

      // Finish anything a previous crash left half-done.
      const recoveredInvoices = await this.recoverStuckInvoices();

      const walletBalance = await this.fetchWalletBalance();
      const transactions = await this.fetchTransactions();

      const summary = {
        ...emptySummary,
        totalTransactions: transactions.length,
        recentTransactions: transactions,
        totalBalance: walletBalance,
        recoveredInvoices,
      };

      if (transactions.length === 0) {
        log("info", "No incoming TRX transactions found");
        return summary;
      }

      for (const tx of transactions) {
        const result = await this.processTransaction(tx);
        if (!result) continue;
        if (result.processed) summary.processedTransactions += 1;
        summary.matchedInvoices += result.matchedCount || 0;
        summary.confirmedInvoices += result.confirmedCount || 0;
        summary.rejectedInvoices += result.rejectedCount || 0;
        summary.pendingMatches += result.pendingCount || 0;
        if (Array.isArray(result.matchedInvoiceDetails)) {
          summary.matchedInvoiceDetails.push(...result.matchedInvoiceDetails);
        }
      }

      log("info", "Scan complete", {
        scanCount: this.scanCount,
        transactions: summary.totalTransactions,
        confirmed: summary.confirmedInvoices,
        rejected: summary.rejectedInvoices,
        recovered: summary.recoveredInvoices,
      });

      return summary;
    } catch (error) {
      log("error", "Scan failed", { error: error.message });
      return { ...emptySummary, error: error.message };
    } finally {
      this.isScanning = false;
      if (redisLockAcquired) {
        try {
          await redisClient.del(TRX_CRON_LOCK_KEY);
        } catch {
          /* TTL will clean up */
        }
      }
    }
  }

  // ── TronScan reads ─────────────────────────────────────────────────────────
  async fetchWalletBalance() {
    try {
      const response = await axios.get("https://apilist.tronscanapi.com/api/account/tokens", {
        params: { address: this.walletAddress, start: 0, limit: 100 },
      });
      const trxToken = response.data?.data?.find(
        (t) => t.tokenAbbr === "trx" || t.tokenId === "_"
      );
      if (trxToken) {
        return parseFloat(trxToken.balance) / Math.pow(10, trxToken.tokenDecimal || 6);
      }

      const accountResponse = await axios.get(
        `https://apilist.tronscanapi.com/api/account?address=${this.walletAddress}`
      );
      if (accountResponse.data?.balance) {
        return parseFloat(accountResponse.data.balance) / 1e6;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  async fetchTransactions() {
    try {
      const response = await axios.get("https://apilist.tronscanapi.com/api/transaction", {
        params: {
          sort: "-timestamp",
          count: true,
          limit: RECENT_TX_LIMIT,
          start: 0,
          address: this.walletAddress,
        },
      });

      const list = response.data?.data;
      if (!Array.isArray(list)) return [];

      return list.filter(
        (tx) =>
          tx.toAddress === this.walletAddress &&
          tx.contractType === 1 &&
          tx.tokenInfo?.tokenAbbr === "trx"
      );
    } catch (error) {
      log("error", "Failed to fetch transactions", { error: error.message });
      return [];
    }
  }

  // ── Transaction processing ─────────────────────────────────────────────────
  async processTransaction(tx) {
    const none = {
      processed: false,
      matchedCount: 0,
      confirmedCount: 0,
      rejectedCount: 0,
      pendingCount: 0,
      matchedInvoiceDetails: [],
    };

    try {
      if (tx.contractType !== 1 || tx.tokenInfo?.tokenAbbr !== "trx") return none;
      if (tx.toAddress !== this.walletAddress) return none;

      const txAmount = parseFloat(tx.amount) / 1e6;
      const invoices = await this.findMatchingInvoices(txAmount);

      if (invoices.length === 0) {
        return { ...none, processed: true };
      }

      const isConfirmed = tx.confirmed && tx.contractRet === "SUCCESS" && !tx.revert;

      // One on-chain transfer settles at most ONE invoice. Iterate and stop at
      // the first invoice we can actually claim, so a single deposit can never
      // clear several pending invoices.
      for (const invoice of invoices) {
        if (isConfirmed) {
          const confirmed = await this.confirmInvoice(invoice, tx);
          if (confirmed) {
            return {
              processed: true,
              matchedCount: 1,
              confirmedCount: 1,
              rejectedCount: 0,
              pendingCount: 0,
              matchedInvoiceDetails: [
                {
                  invoiceId: invoice.invoiceId,
                  amount: invoice.amount,
                  cryptoAmount: invoice.cryptoAmount,
                },
              ],
            };
          }
          // Lost the claim race (already processed, or hash already consumed) —
          // try the next candidate.
          continue;
        }

        if (tx.revert) {
          const rejected = await this.rejectInvoice(invoice, tx);
          if (rejected) {
            return {
              processed: true,
              matchedCount: 1,
              confirmedCount: 0,
              rejectedCount: 1,
              pendingCount: 0,
              matchedInvoiceDetails: [],
            };
          }
          continue;
        }

        // Still awaiting confirmation on-chain — report as pending, take no action.
        log("info", "Transaction awaiting on-chain confirmation", { hash: tx.hash });
        return {
          processed: true,
          matchedCount: 1,
          confirmedCount: 0,
          rejectedCount: 0,
          pendingCount: 1,
          matchedInvoiceDetails: [],
        };
      }

      return { ...none, processed: true };
    } catch (error) {
      log("error", "Error processing transaction", { error: error.message });
      return none;
    }
  }

  async findMatchingInvoices(txAmount) {
    if (mongoose.connection?.readyState !== 1) return [];

    try {
      const invoices = await CryptoInvoice.find({
        status: "unpaid",
        paymentType: "trx",
        currency: "TRX",
      }).maxTimeMS(5000);

      return invoices.filter((invoice) => {
        if (!invoice.cryptoAmount) return false;
        const percentage = Math.abs(invoice.cryptoAmount - txAmount) / invoice.cryptoAmount;
        return percentage <= MATCH_TOLERANCE;
      });
    } catch (error) {
      log("error", "Failed to search matching invoices", { error: error.message });
      return [];
    }
  }

  /**
   * Phase 1 + Phase 2 for a matched invoice.
   * @returns {Promise<boolean>} true when this call performed the fulfillment
   */
  async confirmInvoice(invoice, tx) {
    let claimed;
    try {
      claimed = await CryptoInvoice.findOneAndUpdate(
        { _id: invoice._id, status: "unpaid" },
        {
          $set: {
            status: "paid",
            transactionHash: tx.hash,
            confirmedAt: new Date(),
          },
        },
        { new: true }
      );
    } catch (err) {
      if (err?.code === 11000) {
        // The on-chain hash is already bound to another invoice.
        log("warn", "Transaction hash already consumed — skipping invoice", {
          invoiceId: invoice.invoiceId, hash: tx.hash,
        });
        return false;
      }
      log("error", "Failed to claim invoice", { invoiceId: invoice.invoiceId, error: err.message });
      return false;
    }

    if (!claimed) {
      log("info", "Invoice already settled by another worker", { invoiceId: invoice.invoiceId });
      return false;
    }

    // Phase 2 — credit exactly once, then notify.
    const credited = await this.creditAndNotify(claimed, tx);
    return credited;
  }

  async rejectInvoice(invoice, tx) {
    try {
      const claimed = await CryptoInvoice.findOneAndUpdate(
        { _id: invoice._id, status: "unpaid" },
        { $set: { status: "rejected", transactionHash: tx.hash, rejectedAt: new Date() } },
        { new: true }
      );
      if (!claimed) return false;

      log("warn", "Invoice rejected (transaction reverted)", {
        invoiceId: invoice.invoiceId, hash: tx.hash,
      });
      await this.sendPaymentRejection(claimed, tx);
      return true;
    } catch (err) {
      if (err?.code === 11000) return false;
      log("error", "Failed to reject invoice", { invoiceId: invoice.invoiceId, error: err.message });
      return false;
    }
  }

  /**
   * Phase 2: atomically mark balanceCredited, increment the wallet, then notify.
   * Crediting happens BEFORE the notification so a user is never told "paid"
   * for money that was not actually added.
   */
  async creditAndNotify(invoice, tx) {
    const phase2 = await CryptoInvoice.findOneAndUpdate(
      { _id: invoice._id, status: "paid", balanceCredited: false },
      { $set: { balanceCredited: true, balanceCreditedAt: new Date() } },
      { new: true }
    );

    if (!phase2) {
      log("info", "Phase-2 already completed", { invoiceId: invoice.invoiceId });
      return false;
    }

    let user;
    try {
      const User = (await import("../models/User.js")).default;
      user = await User.findOneAndUpdate(
        { telegramId: String(invoice.userId) },
        { $inc: { balance: invoice.amount, successfulPayments: 1 } },
        { new: true }
      );
    } catch (err) {
      // Roll the flag back so the next scan retries.
      await CryptoInvoice.findOneAndUpdate(
        { _id: invoice._id, balanceCredited: true },
        { $set: { balanceCredited: false, balanceCreditedAt: null } }
      ).catch(() => {});
      log("error", "Wallet credit failed — Phase-2 flag rolled back", {
        invoiceId: invoice.invoiceId, error: err.message,
      });
      await this.alertAdmin(
        `❌ <b>شارژ کیف پول ناموفق</b>\n` +
          `🧾 فاکتور: <code>${invoice.invoiceId}</code>\n` +
          `👤 کاربر: <code>${invoice.userId}</code>\n` +
          `💰 مبلغ: <code>${invoice.amount.toLocaleString()}</code> تومان\n` +
          `خطا: <code>${err.message}</code>`
      );
      return false;
    }

    if (!user) {
      log("warn", "User not found for wallet credit", {
        invoiceId: invoice.invoiceId, userId: invoice.userId,
      });
      await this.alertAdmin(
        `⚠️ <b>کاربر یافت نشد — موجودی اضافه نشد</b>\n` +
          `🧾 فاکتور: <code>${invoice.invoiceId}</code>\n` +
          `👤 کاربر: <code>${invoice.userId}</code>\n` +
          `💰 مبلغ: <code>${invoice.amount.toLocaleString()}</code> تومان`
      );
    }

    log("info", "WALLET_CREDITED", {
      invoiceId: invoice.invoiceId,
      userId: invoice.userId,
      amount: invoice.amount,
      newBalance: user?.balance ?? null,
    });

    await this.sendPaymentConfirmation(invoice, tx, user?.balance ?? null);
    return true;
  }

  /**
   * Crash recovery: complete invoices stuck between Phase 1 and Phase 2.
   * @returns {Promise<number>} how many were completed
   */
  async recoverStuckInvoices() {
    try {
      const stuck = await CryptoInvoice.find({ status: "paid", balanceCredited: false })
        .limit(RECOVERY_BATCH_SIZE)
        .lean();

      if (stuck.length === 0) return 0;

      log("warn", `Recovering ${stuck.length} stuck invoice(s)`);
      let recovered = 0;
      for (const inv of stuck) {
        const tx = { hash: inv.transactionHash || "recovered", confirmed: true, contractRet: "SUCCESS" };
        const ok = await this.creditAndNotify(inv, tx);
        if (ok) recovered += 1;
      }
      return recovered;
    } catch (err) {
      log("error", "Recovery sweep failed", { error: err.message });
      return 0;
    }
  }

  // ── Notifications ──────────────────────────────────────────────────────────
  async alertAdmin(html) {
    const groupId = process.env.GROUP_ID;
    if (!groupId || !this.botInstance) return;
    try {
      await this.botInstance.sendMessage(groupId, `🚨 <b>TRX Scanner</b>\n\n${html}`, {
        parse_mode: "HTML",
      });
    } catch (e) {
      log("warn", "Admin alert failed", { error: e.message });
    }
  }

  async sendPaymentConfirmation(invoice, tx, newBalance) {
    if (!this.botInstance) return;

    const userId = invoice.userId;

    // Remove the wallet-instructions message if we still know its id.
    try {
      const session = await getSession(userId);
      if (session?.walletMessageId) {
        await this.botInstance.deleteMessage(userId, session.walletMessageId);
      }
    } catch { /* non-fatal */ }

    const balanceLine =
      newBalance !== null && newBalance !== undefined
        ? `💳 <b>موجودی جدید:</b> <code>${Number(newBalance).toLocaleString("en-US")}</code> تومان\n`
        : "";

    const message =
      `🎉 <b>پرداخت شما تایید شد!</b>\n\n` +
      `🧾 <b>فاکتور:</b> <code>${invoice.invoiceId}</code>\n` +
      `💰 <b>مبلغ:</b> <code>${invoice.amount.toLocaleString("en-US")}</code> تومان\n` +
      `🪙 <b>مبلغ TRX:</b> <code>${Number(invoice.cryptoAmount).toFixed(6)}</code> TRX\n` +
      `🔗 <b>هش تراکنش:</b> <code>${tx.hash}</code>\n` +
      balanceLine +
      `\n⏰ <b>زمان تایید:</b> ${new Date().toLocaleString("fa-IR")}`;

    try {
      await this.botInstance.sendMessage(userId, message, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }],
          ],
        },
      });
    } catch (e) {
      log("warn", "User confirmation failed (non-fatal)", {
        userId, invoiceId: invoice.invoiceId, error: e.message,
      });
    }
  }

  async sendPaymentRejection(invoice, tx) {
    if (!this.botInstance) return;
    const userId = invoice.userId;

    try {
      const session = await getSession(userId);
      if (session?.walletMessageId) {
        await this.botInstance.deleteMessage(userId, session.walletMessageId);
      }
    } catch { /* non-fatal */ }

    try {
      await this.botInstance.sendMessage(
        userId,
        `❌ <b>پرداخت شما رد شد!</b>\n\n` +
          `🚫 <b>فاکتور:</b> <code>${invoice.invoiceId}</code>\n` +
          `💰 <b>مبلغ:</b> <code>${invoice.amount.toLocaleString("en-US")}</code> تومان\n` +
          `🔗 <b>هش تراکنش:</b> <code>${tx.hash}</code>\n\n` +
          `⚠️ <b>دلیل:</b> تراکنش ناموفق یا revert شده بود.\n\n` +
          `🔄 <b>لطفاً دوباره تلاش کنید یا از روش‌های دیگر پرداخت استفاده کنید.</b>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 تلاش مجدد", callback_data: "back_to_topup" }],
              [{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }],
            ],
          },
        }
      );
    } catch (e) {
      log("warn", "User rejection notice failed (non-fatal)", {
        userId, invoiceId: invoice.invoiceId, error: e.message,
      });
    }
  }

  // ── Admin helpers ──────────────────────────────────────────────────────────
  async manualScan() {
    log("info", "Manual TRX wallet scan initiated");
    return this.scanWallet();
  }

  async checkTronScanStatus() {
    const isConnected = await this.checkTronScanConnection();
    return {
      connected: isConnected,
      walletAddress: this.walletAddress,
      timestamp: new Date().toISOString(),
    };
  }
}

const trxScanner = new TRXWalletScanner();

export default trxScanner;
