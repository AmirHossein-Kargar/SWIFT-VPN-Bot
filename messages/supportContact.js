/**
 * Central support-contact configuration.
 *
 * The direct support identifier is configurable through the SUPPORT_CONTACT
 * environment variable (e.g. "@swift_support" or a numeric Telegram ID).
 * Nothing is hardcoded in source; when unset, only the in-bot support flow
 * is offered.
 */

export function getSupportContact() {
  const raw = String(process.env.SUPPORT_CONTACT || "").trim();
  if (!raw) return null;
  // Accept "@username" or a numeric Telegram ID.
  if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(raw)) {
    return raw.startsWith("@") ? raw : `@${raw}`;
  }
  if (/^[1-9]\d{0,19}$/.test(raw)) return raw;
  return null;
}

export function getSupportContactUrl() {
  const contact = getSupportContact();
  if (!contact) return null;
  return contact.startsWith("@")
    ? `https://t.me/${contact.slice(1)}`
    : `https://t.me/${contact}`;
}

/**
 * Persian support notice shown when the user enters support mode.
 * The direct-contact block is included only when a contact is configured.
 */
export function getSupportMessage() {
  const contact = getSupportContact();
  const directBlock = contact
    ? `▫️ جهت ارتباط به صورت مستقیم:\n🔰 ${contact}\n\n`
    : "";
  return `${directBlock}‼️ قبل از ارسال پیام به پشتیبانی، قوانین و مقررات سرویس‌ دهی را مطالعه کنید.

📝 لطفاً پیام پشتیبانی خود را در همین چت تایپ و ارسال کنید.

✅ فایل‌های مجاز: متن، عکس، فیلم`;
}

/** Persian notice for unsupported media types while in support mode. */
export function getUnsupportedMediaMessage() {
  return getSupportMessage();
}

/** Inline keyboard row(s) linking to the direct support chat, when configured. */
export function getSupportDirectButton() {
  const url = getSupportContactUrl();
  if (!url) return [];
  return [[{ text: "📩 گفتگو با پشتیبانی", url }]];
}
