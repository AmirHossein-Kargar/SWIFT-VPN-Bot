/**
 * Customer-facing support copy (Persian). Every Telegram support screen and
 * the customer web area read their wording from here so the same sentence is
 * never written two slightly different ways. The admin panel is English-only
 * and does not use this module.
 */

export const SUPPORT_COPY = Object.freeze({
  title: "پشتیبانی",
  description: "اگر در استفاده از سرویس با مشکلی روبه‌رو شده‌اید یا سؤالی دارید، از طریق ثبت تیکت با تیم پشتیبانی در ارتباط باشید.",
  newTicket: "ثبت تیکت جدید",
  myTickets: "تیکت‌های من",
  directContact: "ارتباط مستقیم با پشتیبانی",
  webPanel: "مشاهده در پنل وب",
  terms: "قوانین و شرایط استفاده",
  back: "بازگشت",
  backToMenu: "بازگشت به منوی اصلی",
  cancel: "انصراف",
  viewTicket: "مشاهده تیکت",
  closeTicket: "بستن تیکت",
  confirmClose: "بله، تیکت بسته شود",

  termsNotice: "پیش از ثبت درخواست، لطفاً قوانین و شرایط استفاده از سرویس را مطالعه کنید. برای پیگیری دقیق‌تر، موضوع هر درخواست را در یک تیکت جداگانه مطرح کنید.",
  newTicketPrompt: "لطفاً مشکل یا درخواست خود را به‌صورت واضح توضیح دهید. در صورت نیاز می‌توانید تصویر یا ویدیوی مرتبط نیز ارسال کنید.",
  allowedFiles: "فایل‌های مجاز: متن، تصویر و ویدیو",
  ticketCreatedHint: "پاسخ‌های پشتیبانی در همین تیکت نمایش داده می‌شوند. برای پیگیری این درخواست، لطفاً پیام‌های خود را در همین گفت‌وگو ارسال کنید.",
  messagePrompt: "پیام خود را بنویسید یا فایل مرتبط را ارسال کنید.",
  adminReply: "پاسخ جدیدی از تیم پشتیبانی دریافت کرده‌اید. برای مشاهده و ادامه گفت‌وگو، وارد تیکت خود شوید.",
  closed: "این تیکت بسته شده است و امکان ارسال پیام در آن وجود ندارد. اگر همچنان به کمک نیاز دارید، لطفاً تیکت جدیدی ثبت کنید.",
  noTickets: "هنوز تیکتی ثبت نکرده‌اید.",
  noMessages: "گفت‌وگو هنوز شروع نشده است. پیام خود را ارسال کنید تا تیم پشتیبانی بتواند راهنمایی‌تان کند.",

  confirmCloseQuestion: "با بستن تیکت دیگر امکان ارسال پیام در آن وجود نخواهد داشت و تیکت قابل بازگشایی نیست. ادامه می‌دهید؟",
  closedByYou: "تیکت بسته شد. اگر همچنان به کمک نیاز دارید، لطفاً تیکت جدیدی ثبت کنید.",
  unsupportedFile: "این نوع فایل پشتیبانی نمی‌شود. لطفاً فقط متن، تصویر یا ویدیو ارسال کنید.",
  genericError: "مشکلی در ثبت پیام رخ داد. لطفاً دوباره تلاش کنید.",
  buttonExpired: "این دکمه دیگر معتبر نیست.",
  webUnavailable: "پنل وب در دسترس نیست.",
  webLoginLink: "لینک ورود یک‌بارمصرف به پنل پشتیبانی (۵ دقیقه معتبر است):",
  groupOpenPanel: "باز کردن در پنل مدیریت",
  webLoginButton: "ورود به پنل پشتیبانی",
});

export const CUSTOMER_STATUS_LABELS = Object.freeze({
  open: "باز",
  pending_customer: "در انتظار پاسخ شما",
  closed: "بسته",
});

export function customerStatusLabel(status) {
  return CUSTOMER_STATUS_LABELS[status] || CUSTOMER_STATUS_LABELS.open;
}

export const groupRepliesDisabled = (ticketId) => `پاسخ به تیکت ${ticketId} از داخل گروه دیگر پشتیبانی نمی‌شود. لطفاً از صندوق تیکت‌ها در پنل مدیریت استفاده کنید.`;

export const ticketCreated = (ticketId) => `درخواست شما با موفقیت ثبت شد. شماره تیکت: ${ticketId}`;
export const messageRecorded = (ticketId) => `پیام شما در تیکت ${ticketId} ثبت شد.`;
export const ticketClosedNotice = (ticketId) => `تیکت ${ticketId} توسط پشتیبانی بسته شد. اگر همچنان به کمک نیاز دارید، لطفاً تیکت جدیدی ثبت کنید.`;
export const groupNewTicketAlert = (ticketId) => `تیکت جدید ${ticketId} ثبت شد. برای مشاهده و پاسخ، وارد پنل مدیریت شوید.`;
