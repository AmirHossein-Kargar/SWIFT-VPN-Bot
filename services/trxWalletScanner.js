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
import User from "../models/User.js";
import { getSession } from "../config/sessionStore.js";
import mongoose from "mongoose";
import { acquireRedisLease, releaseRedisLease, startRedisLeaseHeartbeat } from "./redisLease.js";
import { creditWalletOnce } from "./walletCredit.js";
import { recordJobRun } from "./admin/monitoring.js";

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
      const res = await axios.get("https://apilist.tronscanapi.com/api/account", {
        params: { address: this.walletAddress },
        timeout: 8_000,
      });
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
      this.scanWallet().catch((e) => log("error", "Unhandled scan error", { errorType: e?.name || "Error" }));
    }, SCAN_INTERVAL_MS);
    if (this.scanInterval.unref) this.scanInterval.unref();

    // Initial run (not awaited — startAutoScan stays synchronous for callers)
    this.scanWallet().catch((e) => log("error", "Unhandled scan error", { errorType: e?.name || "Error" }));
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

    // Redis serializes normal scans across replicas. The unique transaction-hash
    // index and wallet credit ledger remain the authoritative safety controls.
    let redisLease = null;
    let leaseHealthy = true;
    let stopLeaseHeartbeat = null;
    try {
      redisLease = await acquireRedisLease(TRX_CRON_LOCK_KEY, TRX_CRON_LOCK_TTL);
      if (!redisLease) {
        log("info", "Scan lease is held by another instance — skipping");
        return emptySummary;
      }
      stopLeaseHeartbeat = startRedisLeaseHeartbeat(redisLease, {
        ttlSeconds: TRX_CRON_LOCK_TTL,
        intervalMs: 60_000,
        onLost: async () => {
          leaseHealthy = false;
          log("error", "Scan lease lost; stopping this scan");
        },
      });
    } catch (error) {
      // Redis is an optimization only. MongoDB uniqueness and the in-process
      // guard still prevent repeated wallet credits when Redis is unavailable.
      log("warn", "Redis scan lease unavailable; using database safeguards", {
        errorType: error?.name || "RedisError",
      });
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
      if (!leaseHealthy) return emptySummary;

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
        if (!leaseHealthy) break;
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
      this.recordScanOutcome(summary);

      return summary;
    } catch (error) {
      log("error", "Scan failed", { errorType: error?.name || "Error" });
      this.recordScanOutcome({ error: "scan_failed" });
      return { ...emptySummary, error: "TRX scan failed" };
    } finally {
      this.isScanning = false;
      stopLeaseHeartbeat?.();
      if (redisLease) {
        try { await releaseRedisLease(redisLease); } catch { /* TTL will clean up */ }
      }
    }
  }

  /** Report the outcome of the last scan to the admin monitoring service. */
  recordScanOutcome(summary) {
    try {
      const failed = typeof summary?.error === "string";
      recordJobRun("trx-scanner", {
        ok: !failed,
        meta: {
          lastScanTime: this.lastScanTime ? new Date(this.lastScanTime).toISOString() : null,
          scanCount: this.scanCount,
        },
      });
    } catch { /* monitoring must never affect the scanner */ }
  }

  // ── TronScan reads ─────────────────────────────────────────────────────────
  async fetchWalletBalance() {
    try {
      const response = await axios.get("https://apilist.tronscanapi.com/api/account/tokens", {
        params: { address: this.walletAddress, start: 0, limit: 100 },
        timeout: 8_000,
      });
      const trxToken = response.data?.data?.find(
        (t) => t.tokenAbbr === "trx" || t.tokenId === "_"
      );
      if (trxToken) {
        const balance = Number(trxToken.balance) / Math.pow(10, Number(trxToken.tokenDecimal) || 6);
        return Number.isFinite(balance) ? balance : null;
      }

      const accountResponse = await axios.get("https://apilist.tronscanapi.com/api/account", {
        params: { address: this.walletAddress },
        timeout: 8_000,
      });
      if (accountResponse.data?.balance != null) {
        const balance = Number(accountResponse.data.balance) / 1e6;
        return Number.isFinite(balance) ? balance : null;
      }
      return null;
    } catch (error) {
      log("warn", "TronScan wallet balance unavailable", { errorType: error?.name || "NetworkError" });
      return null;
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
        timeout: 8_000,
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
      log("error", "Failed to fetch transactions", { errorType: error?.name || "NetworkError" });
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
      if (typeof tx.hash !== "string" || !/^[A-Fa-f0-9]{16,128}$/.test(tx.hash)) return none;

      const txAmount = Number(tx.amount) / 1e6;
      if (!Number.isFinite(txAmount) || txAmount <= 0) return none;
      let invoices = await this.findMatchingInvoices(txAmount);

      if (invoices.length === 0) return { ...none, processed: true };
      if (invoices.length > 1) {
        const exact = invoices.filter((candidate) => Math.round(Number(candidate.cryptoAmount) * 1_000_000) === Math.round(txAmount * 1_000_000));
        if (exact.length === 1) {
          invoices = exact;
        } else {
          log("warn", "TRX transfer matches multiple invoices; automatic credit withheld", {
            hash: tx.hash, candidateCount: invoices.length,
          });
          await this.alertAdmin(
            `⚠️ <b>واریز TRX مبهم است</b>\n` +
            `هش: <code>${tx.hash}</code>\n` +
            `تعداد فاکتورهای نزدیک: <code>${invoices.length}</code>\n` +
            `برای جلوگیری از شارژ اشتباه، تطبیق خودکار انجام نشد.`
          );
          return { ...none, processed: true };
        }
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
      log("error", "Error processing transaction", { errorType: error?.name || "Error" });
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
      log("error", "Failed to search matching invoices", { errorType: error?.name || "DatabaseError" });
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
            creditLedgerVersion: 2,
            notificationPending: true,
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
      log("error", "Failed to claim invoice", { invoiceId: invoice.invoiceId, errorType: err?.name || "DatabaseError" });
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
      log("error", "Failed to reject invoice", { invoiceId: invoice.invoiceId, errorType: err?.name || "DatabaseError" });
      return false;
    }
  }

  /**
   * Apply the wallet credit through the shared idempotency ledger, then persist
   * invoice completion and deliver a retryable notification.
   */
  async creditAndNotify(invoice, tx) {
    let current = await CryptoInvoice.findById(invoice._id).lean();
    if (!current || current.status !== "paid") return false;

    if (!current.balanceCredited && current.creditLedgerVersion !== 2) {
      const alertClaim = await CryptoInvoice.findOneAndUpdate(
        {
          _id: current._id,
          status: "paid",
          balanceCredited: false,
          creditLedgerVersion: { $ne: 2 },
          legacyReviewAlertedAt: null,
        },
        { $set: { legacyReviewAlertedAt: new Date() } },
        { new: true }
      );
      if (alertClaim) {
        await this.alertAdmin(
          `⚠️ <b>فاکتور قدیمی TRX نیازمند تطبیق دستی است</b>\n` +
            `🧾 فاکتور: <code>${current.invoiceId}</code>\n` +
            `👤 کاربر: <code>${current.userId}</code>\n` +
            `برای جلوگیری از شارژ تکراری، بازیابی خودکار انجام نشد.`
        );
      }
      log("error", "Legacy TRX credit requires manual reconciliation", { invoiceId: current.invoiceId });
      return false;
    }

    let creditResult = null;
    if (!current.balanceCredited) {
      try {
        creditResult = await creditWalletOnce({
          telegramId: current.userId,
          amount: Number(current.amount),
          creditKey: `trx:${current.invoiceId}`,
        });
      } catch (error) {
        log("error", "Atomic TRX wallet credit failed", {
          invoiceId: current.invoiceId,
          errorType: error?.name || "DatabaseError",
          code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
        });
        await this.alertAdmin(
          `❌ <b>شارژ کیف پول TRX ناموفق</b>\n` +
            `🧾 فاکتور: <code>${current.invoiceId}</code>\n` +
            `👤 کاربر: <code>${current.userId}</code>\n` +
            `لطفاً دیتابیس و فاکتور را بررسی کنید.`
        );
        return false;
      }

      if (!creditResult.user) {
        log("error", "TRX wallet owner not found", { invoiceId: current.invoiceId, userId: current.userId });
        await this.alertAdmin(
          `⚠️ <b>کاربر پرداخت TRX یافت نشد</b>\n` +
            `🧾 فاکتور: <code>${current.invoiceId}</code>\n` +
            `👤 کاربر: <code>${current.userId}</code>\n` +
            `💰 مبلغ: <code>${Number(current.amount).toLocaleString("en-US")}</code> تومان`
        );
        return false;
      }

      const finalized = await CryptoInvoice.findOneAndUpdate(
        { _id: current._id, status: "paid", creditLedgerVersion: 2, balanceCredited: false },
        { $set: { balanceCredited: true, balanceCreditedAt: new Date(), notificationPending: true } },
        { new: true }
      );
      if (finalized) {
        current = finalized.toObject ? finalized.toObject() : finalized;
      } else {
        current = await CryptoInvoice.findById(current._id).lean();
        if (!current?.balanceCredited) {
          log("error", "TRX balance was durably credited but invoice flag is pending", { invoiceId: invoice.invoiceId });
          return false;
        }
      }
      log("info", "TRX wallet credit ledger committed", {
        invoiceId: current.invoiceId,
        userId: current.userId,
        amount: current.amount,
        newlyCredited: creditResult.credited,
      });
    } else {
      creditResult = {
        user: await User.findOne({ telegramId: String(current.userId) }).select("balance").lean(),
        credited: false,
        alreadyCredited: true,
      };
    }

    if (current.notificationPending) {
      await this.sendPaymentConfirmation(current, tx, creditResult?.user?.balance ?? null);
    }
    return true;
  }

  /**
   * Crash recovery: complete invoices stuck between Phase 1 and Phase 2.
   * @returns {Promise<number>} how many were completed
   */
  async recoverStuckInvoices() {
    try {
      const stuck = await CryptoInvoice.find({
        status: "paid",
        creditLedgerVersion: 2,
        $or: [{ balanceCredited: false }, { notificationPending: true }],
      }).limit(RECOVERY_BATCH_SIZE).lean();

      const legacy = await CryptoInvoice.find({
        status: "paid",
        balanceCredited: false,
        creditLedgerVersion: { $ne: 2 },
        legacyReviewAlertedAt: null,
      }).limit(RECOVERY_BATCH_SIZE).lean();
      for (const invoice of legacy) await this.creditAndNotify(invoice, { hash: invoice.transactionHash || "manual_review" });

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
      log("error", "Recovery sweep failed", { errorType: err?.name || "DatabaseError" });
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
      log("warn", "Admin alert failed", { errorType: e?.name || "TelegramError" });
    }
  }

  async sendPaymentConfirmation(invoice, tx, newBalance) {
    if (!this.botInstance) return false;
    const now = new Date();
    const staleClaim = new Date(now.getTime() - 5 * 60_000);
    const claim = await CryptoInvoice.findOneAndUpdate(
      {
        _id: invoice._id,
        status: "paid",
        balanceCredited: true,
        creditLedgerVersion: 2,
        notificationPending: true,
        $or: [
          { notificationClaimedAt: null },
          { notificationClaimedAt: { $lt: staleClaim } },
        ],
      },
      { $set: { notificationClaimedAt: now } },
      { new: true }
    );
    if (!claim) return false;

    const userId = claim.userId;
    try {
      const session = await getSession(userId);
      if (session?.walletMessageId) {
        await this.botInstance.deleteMessage(userId, session.walletMessageId).catch(() => {});
      }
    } catch { /* non-fatal */ }

    const balanceLine = newBalance !== null && newBalance !== undefined
      ? `💳 <b>موجودی جدید:</b> <code>${Number(newBalance).toLocaleString("en-US")}</code> تومان\n`
      : "";
    const message =
      `🎉 <b>پرداخت شما تایید شد!</b>\n\n` +
      `🧾 <b>فاکتور:</b> <code>${claim.invoiceId}</code>\n` +
      `💰 <b>مبلغ:</b> <code>${Number(claim.amount).toLocaleString("en-US")}</code> تومان\n` +
      `🪙 <b>مبلغ TRX:</b> <code>${Number(claim.cryptoAmount).toFixed(6)}</code> TRX\n` +
      `🔗 <b>هش تراکنش:</b> <code>${String(tx?.hash || claim.transactionHash || "").replace(/[^A-Fa-f0-9_]/g, "")}</code>\n` +
      balanceLine +
      `\n⏰ <b>زمان تایید:</b> ${new Date().toLocaleString("fa-IR")}`;

    try {
      await this.botInstance.sendMessage(userId, message, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }]],
        },
      });
      await CryptoInvoice.findOneAndUpdate(
        { _id: claim._id, notificationClaimedAt: now, notificationPending: true },
        { $set: { notificationPending: false, notifiedAt: new Date() }, $unset: { notificationClaimedAt: 1 } }
      );
      return true;
    } catch (error) {
      // A stale claim is retried after five minutes; immediate retries could
      // duplicate a Telegram notification accepted before a network timeout.
      log("warn", "TRX user notification failed; retry delayed", {
        invoiceId: claim.invoiceId, errorType: error?.name || "TelegramError",
      });
      return false;
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
        userId, invoiceId: invoice.invoiceId, errorType: e?.name || "TelegramError",
      });
    }
  }

  // ── Admin helpers ──────────────────────────────────────────────────────────
  async manualScan() {
    log("info", "Manual TRX wallet scan initiated");
    return this.scanWallet();
  }

  /**
   * Complete a single stuck TRX invoice (paid but not yet credited/notified).
   * Reuses the same idempotent Phase-2 path as the scanner, so calling it twice
   * can never credit twice. Returns false when the invoice is not recoverable.
   */
  async recoverInvoice(invoiceId) {
    if (typeof invoiceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(invoiceId)) return false;
    try {
      const invoice = await CryptoInvoice.findOne({ invoiceId }).lean();
      if (!invoice || invoice.status !== "paid" || invoice.balanceCredited) {
        return Boolean(invoice && invoice.balanceCredited);
      }
      return await this.creditAndNotify(invoice, { hash: invoice.transactionHash || "admin-recovery", confirmed: true, contractRet: "SUCCESS" });
    } catch (error) {
      log("error", "Admin-requested invoice recovery failed", {
        invoiceId, errorType: error?.name || "DatabaseError",
      });
      return false;
    }
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
