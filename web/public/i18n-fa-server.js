/* Persian text for strings produced by the server (analytics definitions, notes).
   Generated from services/admin/analyticsReport.js DEFINITIONS; keep in sync (a unit test enforces it). */
(function () {
  "use strict";
  var fa = {
  "All registered users (all time).": "همهٔ کاربران ثبت‌نام‌شده (از ابتدا).",
  "Users whose account was created in the period.": "کاربرانی که حسابشان در این بازه ساخته شده است.",
  "Non-blocked users whose last recorded activity falls inside the period.": "کاربران مسدودنشده که آخرین فعالیت ثبت‌شده‌شان در این بازه است.",
  "Completed, non-revoked purchases whose expiry is in the future.": "خریدهای تکمیل‌شدهٔ لغونشده که انقضایشان در آینده است.",
  "Purchases completed (service delivered) in the period, by completion time.": "خریدهایی که در این بازه تکمیل (سرویس تحویل) شده‌اند، بر اساس زمان تکمیل.",
  "Active services expiring within the next 7 days.": "سرویس‌های فعال که تا ۷ روز آینده منقضی می‌شوند.",
  "Invoices created in the period across all providers, one per invoice (webhook repeats are not counted), plus invoices removed by the 24h cleanup.": "فاکتورهای ایجادشده در بازه برای همهٔ درگاه‌ها، به ازای هر فاکتور یک بار (تکرار وب‌هوک شمرده نمی‌شود)، به‌علاوهٔ فاکتورهای حذف‌شده توسط پاکسازی ۲۴ ساعته.",
  "Attempts that were provider-confirmed AND credited to the wallet.": "تلاش‌هایی که هم توسط درگاه تأیید شده و هم به کیف پول اعتبار داده شده‌اند.",
  "successful / (successful + failed + cancelled + expired). Pending, partially paid, refunded and manual-review attempts are excluded because they are not decided.": "موفق ÷ (موفق + ناموفق + لغوشده + منقضی). تلاش‌های در انتظار، ناقص، بازگشتی و نیازمند بررسی چون هنوز قطعی نیستند حذف می‌شوند.",
  "Attempts that ended failed or rejected (including creation_failed).": "تلاش‌هایی که ناموفق یا ردشده تمام شدند (شامل creation_failed).",
  "Attempts cancelled before payment.": "تلاش‌هایی که پیش از پرداخت لغو شدند.",
  "Partially paid attempts and attempts flagged for manual recovery.": "تلاش‌های ناقص‌پرداخت‌شده و تلاش‌هایی که برای بازیابی دستی علامت خورده‌اند.",
  "Distinct users with at least one completed purchase in the period.": "کاربران متمایزی که در بازه دست‌کم یک خرید تکمیل‌شده دارند.",
  "Share of the previous period's buyers who bought again in this period.": "سهمی از خریداران بازهٔ قبل که در این بازه دوباره خرید کرده‌اند.",
  "Wallet top-ups credited in the period (by credit time). This is money received into wallets, NOT revenue.": "شارژهای کیف پول که در بازه اعتبار داده شده‌اند (بر اساس زمان اعتبار). این پولِ وارد‌شده به کیف پول‌هاست، نه درآمد.",
  "Number of credited top-ups.": "تعداد شارژهای اعتبارداده‌شده.",
  "Gross top-ups / number of credited top-ups.": "شارژ ناخالص ÷ تعداد شارژهای اعتبارداده‌شده.",
  "Value of top-up invoices ending reversed (HooshPay) or refunded (NOWPayments), by invoice creation date.": "ارزش فاکتورهای شارژی که برگشتی (HooshPay) یا بازپرداخت‌شده (NOWPayments) تمام شده‌اند، بر اساس تاریخ ایجاد فاکتور.",
  "Number of reversed/refunded top-up invoices.": "تعداد فاکتورهای شارژِ برگشتی/بازپرداخت‌شده.",
  "Gross top-ups minus refunds/reversals for the same period. Partial refunds are not stored, so this uses full invoice amounts.": "شارژ ناخالص منهای بازپرداخت/برگشت در همان بازه. بازپرداخت جزئی ذخیره نمی‌شود، پس از کل مبلغ فاکتور استفاده می‌شود.",
  "Sum of all wallet balances now (money held on behalf of users).": "مجموع موجودی همهٔ کیف پول‌ها در این لحظه (پولی که به نمایندگی از کاربران نگهداری می‌شود).",
  "Value of services bought from wallets and delivered in the period (by completion time).": "ارزش سرویس‌هایی که از کیف پول خریداری و در این بازه تحویل شده‌اند (بر اساس زمان تکمیل).",
  "Purchases refunded to the wallet in the period (by refund time).": "خریدهایی که در این بازه به کیف پول بازگردانده شده‌اند (بر اساس زمان بازپرداخت).",
  "Gross sales minus refunded purchases.": "فروش ناخالص منهای خریدهای بازپرداخت‌شده.",
  "Gross sales / completed purchases.": "فروش ناخالص ÷ تعداد خریدهای تکمیل‌شده.",
  "The WizardXray integration has no renewal operation and purchases do not record renewals, so renewal trends cannot be computed.": "ادغام ویزاردایکس عملیات تمدید ندارد و خریدها تمدید را ثبت نمی‌کنند؛ پس روند تمدید قابل محاسبه نیست.",
  "Only repeat-purchase retention between the selected and the previous period is available; per-cohort retention needs per-day activity history that is not stored.": "فقط بازگشت خریداران بین بازهٔ انتخابی و بازهٔ قبل در دسترس است؛ بازگشت به تفکیک گروه نیازمند تاریخچهٔ فعالیت روزانه است که ذخیره نمی‌شود.",
  "Only the most recent activity time per user is stored, so 'active users' for a period that already ended is a lower bound.": "فقط آخرین زمان فعالیت هر کاربر ذخیره می‌شود؛ پس «کاربران فعال» برای بازهٔ گذشته حد پایین است.",
  "Refunds and reversals of top-ups are dated by invoice creation (HooshPay/NOWPayments store no refund timestamp).": "بازپرداخت و برگشت شارژها بر اساس تاریخ ایجاد فاکتور ثبت می‌شود (HooshPay/NOWPayments زمان بازپرداخت را ذخیره نمی‌کنند).",
  "HooshPay": "هوش‌پی",
  "NOWPayments": "NOWPayments",
  "Bank card": "کارت بانکی",
  "redis": "ردیس",
  "mongodb": "مونگو",
  "recovery required": "نیاز به بررسی",
  "No VPN services match these filters.": "سرویس VPN با این فیلترها یافت نشد.",
  "Nothing needs recovery. All payments and orders are settled.": "چیزی نیازمند بازیابی نیست. همهٔ پرداخت‌ها و سفارش‌ها تسویه شده‌اند.",
  "Retry all safe": "تلاش مجدد همهٔ موارد امن",
  "Every retry uses the same atomic two-phase MongoDB writes as the payment pipeline": "هر تلاش مجدد از همان نوشتن‌های دومرحله‌ای اتمیک پایگاه‌داده‌ای خط پرداخت استفاده می‌کند",
  "Active VPN services": "سرویس‌های VPN فعال",
  "Users active in the last 30 days": "کاربران فعال در ۳۰ روز اخیر",
  "Registered since midnight UTC": "ثبت‌نام‌شده از نیمه‌شب UTC"
};
  if (typeof SwiftI18n !== "undefined") SwiftI18n.register("fa", fa);
  else if (typeof module === "object" && module.exports) module.exports = { fa: fa };
})();
