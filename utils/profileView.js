const SUCCESSFUL_STATUSES = Object.freeze({
  hoosh: new Set(["paid"]),
  trx: new Set(["paid"]),
  bank: new Set(["confirmed", "paid"]),
});

const PAYMENT_LABELS = Object.freeze({
  hoosh: "پرداخت آنلاین",
  trx: "پرداخت TRX",
  bank: "کارت به کارت",
});

/** Canonical database query for settled, wallet-credited payments by provider. */
export function successfulPaymentQuery(provider, userId) {
  const statuses = SUCCESSFUL_STATUSES[provider];
  if (!statuses) throw new TypeError(`Unsupported payment provider: ${provider}`);

  const status = provider === "bank"
    ? { $in: [...statuses] }
    : [...statuses][0];

  return {
    userId: Number(userId),
    ...(provider === "bank" ? { paymentType: "bank" } : provider === "trx" ? { paymentType: "trx" } : {}),
    status,
    balanceCredited: true,
  };
}

/**
 * Defensive canonical status check; prevents pending/failed records from being
 * rendered even if a repository query or mock unexpectedly returns them.
 */
export function isSuccessfulPayment(provider, record) {
  return Boolean(
    SUCCESSFUL_STATUSES[provider]?.has(record?.status) &&
    record?.balanceCredited === true &&
    (provider !== "bank" || record?.paymentType === "bank") &&
    (provider !== "trx" || record?.paymentType === "trx")
  );
}

/** Merge provider histories, keep only successful payments, and return newest 4. */
export function buildRecentSuccessfulPayments({ hoosh = [], trx = [], bank = [] } = {}) {
  return [
    ...hoosh.map((record) => ({ provider: "hoosh", label: PAYMENT_LABELS.hoosh, record })),
    ...trx.map((record) => ({ provider: "trx", label: PAYMENT_LABELS.trx, record })),
    ...bank.map((record) => ({ provider: "bank", label: PAYMENT_LABELS.bank, record })),
  ]
    .filter(({ provider, record }) => isSuccessfulPayment(provider, record))
    .sort((a, b) => new Date(b.record.createdAt || 0) - new Date(a.record.createdAt || 0))
    .slice(0, 4);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

/** Build the profile body using only fields intended for customer display. */
export function renderProfileMessage({
  user,
  activeServices = 0,
  serviceCount = 0,
  recentPayments = [],
  formattedJoinDate = "—",
  formatPaymentDate = () => "—",
} = {}) {
  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  const recentLines = recentPayments.map(({ label, record }) => {
    const amount = Number(record.amount || 0).toLocaleString("en-US");
    return `▫️ ${label} — <code>${amount}</code> تومان | ✅ موفق | ${formatPaymentDate(record.createdAt)}`;
  });

  return `👤 <b>پروفایل من</b>

🆔 شناسه کاربری: <code>${escapeHtml(user?.telegramId)}</code>
${displayName ? `📌 نام: <b>${escapeHtml(displayName)}</b>\n` : ""}${user?.username ? `🔗 یوزرنیم: @${escapeHtml(user.username)}\n` : ""}
💰 موجودی کیف پول: <b>${Number(user?.balance || 0).toLocaleString("en-US")} تومان</b>

📦 خدمات فعال: <b>${activeServices}</b> از ${serviceCount} سرویس
✅ پرداخت‌های موفق: <b>${Number(user?.successfulPayments || 0)}</b>
${user?.referralCode ? `🎟️ کد معرف شما: <code>${escapeHtml(user.referralCode)}</code>\n` : ""}
🧾 <b>آخرین سفارش‌ها:</b>
${recentLines.length ? recentLines.join("\n") : "▫️ پرداخت موفقی ثبت نشده است."}

🕒 تاریخ عضویت: <code>${escapeHtml(formattedJoinDate)}</code>`;
}
