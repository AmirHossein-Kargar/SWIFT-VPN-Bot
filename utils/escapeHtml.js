/** Escape text interpolated into Telegram HTML messages. */
export default function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

/** Bound and escape an error before it is placed inside a `<code>` block. */
export function escapeErrorMessage(error, fallback = "خطای ناشناخته") {
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message
    : fallback;
  return escapeHtml(message.slice(0, 300));
}
