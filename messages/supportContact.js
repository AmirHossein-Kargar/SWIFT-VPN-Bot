/**
 * Central support-contact configuration.
 *
 * The direct support identifier is configurable through the SUPPORT_CONTACT
 * environment variable (e.g. "@swift_support" or a numeric Telegram ID).
 * Nothing is hardcoded in source; when unset, only the in-bot support flow
 * is offered. Wording lives in ./supportCopy.js.
 */
import { SUPPORT_COPY } from "./supportCopy.js";

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
 * Optional terms page, offered as a button only when SUPPORT_TERMS_URL holds an
 * https URL. Nothing is invented: unset or malformed means no button.
 */
export function getSupportTermsUrl() {
  const raw = String(process.env.SUPPORT_TERMS_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Support menu text: title and a short description. Direct contact is a button, never inline text. */
export function getSupportMessage() {
  return `<b>${SUPPORT_COPY.title}</b>\n\n${SUPPORT_COPY.description}`;
}

/** Prompt shown before the first message of a new ticket. */
export function getNewTicketMessage() {
  return `${SUPPORT_COPY.termsNotice}\n\n${SUPPORT_COPY.newTicketPrompt}\n${SUPPORT_COPY.allowedFiles}`;
}

/** Notice for unsupported media types while in support mode. */
export function getUnsupportedMediaMessage() {
  return `${SUPPORT_COPY.unsupportedFile}\n${SUPPORT_COPY.allowedFiles}`;
}

/** Inline keyboard row(s) linking to the direct support chat, when configured. */
export function getSupportDirectButton() {
  const url = getSupportContactUrl();
  if (!url) return [];
  return [[{ text: SUPPORT_COPY.directContact, url }]];
}

/** Inline keyboard row linking to the terms page, when configured. */
export function getSupportTermsButton() {
  const url = getSupportTermsUrl();
  if (!url) return [];
  return [[{ text: SUPPORT_COPY.terms, url }]];
}
