/**
 * Read-only settings overview for the web admin panel.
 *
 * Every value is either a boolean "is this configured?", a non-sensitive
 * constant the code already enforces, or public runtime metadata. Raw
 * environment values (API keys, secrets, tokens, URLs with credentials,
 * card numbers, wallet addresses) are never returned. Nothing here is
 * editable: configuration changes stay a deployment-time concern.
 */
import { readFileSync } from "node:fs";
import { assertAdminUser } from "./authorization.js";
import { isOwnerUser } from "./adminRegistry.js";
import { mockTestsEnabled } from "../mockTests/runner.js";
import { readNowPaymentsConfig } from "../nowpayments/money.js";
import { ADMIN_SESSION_TTL_SECONDS, LOGIN_CODE_TTL } from "./auth.js";
import { getAdminIds } from "../../utils/auth.js";
import { sessionCookieOptions, SESSION_COOKIE_PATH, NEXT_PANEL_SESSION_COOKIE_PATH } from "../../web/adminMiddleware.js";

const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000));

let packageInfo = null;
function readPackage() {
  if (packageInfo) return packageInfo;
  try {
    const raw = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    packageInfo = { name: String(raw.name || "swift-vpn-bot"), version: String(raw.version || "0.0.0") };
  } catch {
    packageInfo = { name: "swift-vpn-bot", version: "unknown" };
  }
  return packageInfo;
}

const configured = (value) => typeof value === "string" && value.trim().length > 0;

function nowPaymentsStatus(env) {
  try {
    const config = readNowPaymentsConfig(env, { allowWithoutCallback: true });
    return {
      apiKey: Boolean(config?.apiKey),
      ipnVerification: Boolean(config?.ipnSecret && config?.callbackUrl),
      custodyAuth: Boolean(config?.hasCustodyAuth),
      valid: Boolean(config),
    };
  } catch {
    // A present-but-invalid configuration (e.g. public key pasted as API key).
    return { apiKey: configured(env.NOWPAYMENTS_API_KEY), ipnVerification: false, custodyAuth: false, valid: false };
  }
}

export function getSettingsOverview({ actorId, env = process.env, now = new Date() } = {}) {
  const actor = assertAdminUser(actorId);
  const pkg = readPackage();
  const nowPayments = nowPaymentsStatus(env);
  // Read from the same function that issues the cookie, so this can't drift.
  const cookie = sessionCookieOptions(1);
  return {
    generatedAt: now.toISOString(),
    account: {
      telegramId: actor,
      isOwner: isOwnerUser(actor),
      environmentAdminCount: getAdminIds().length,
    },
    application: {
      name: pkg.name,
      version: pkg.version,
      environment: env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development",
      nodeVersion: process.version,
      startedAt: PROCESS_STARTED_AT.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    },
    security: {
      sessionTtlSeconds: ADMIN_SESSION_TTL_SECONDS(),
      loginCodeTtlSeconds: LOGIN_CODE_TTL,
      sessionStore: "redis",
      cookie: { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, paths: [SESSION_COOKIE_PATH, NEXT_PANEL_SESSION_COOKIE_PATH] },
      csrfProtection: true,
      originCheck: true,
      // Mirrors rateLimitMiddleware({ limit }) on /auth/request-code and /auth/verify (60 s window).
      loginRateLimitPerMinute: 5,
      codeVerifyRateLimitPerMinute: 10,
      ownerConfigured: configured(env.OWNER_TELEGRAM_ID) || getAdminIds().length > 0,
    },
    payments: {
      hooshpay: { apiKey: configured(env.HOOSHPAY_API_KEY), webhookSecret: configured(env.HOOSHPAY_WEBHOOK_SECRET) },
      nowpayments: nowPayments,
      trxWallet: configured(env.TRX_WALLET),
      webhookBaseUrl: configured(env.WEBHOOK_BASE_URL),
    },
    vpn: {
      wizardApiUrl: configured(env.WIZARD_API_URL),
      wizardApiKey: configured(env.VPN_API_KEY),
    },
    telegram: {
      botToken: configured(env.BOT_TOKEN),
      adminGroup: configured(env.GROUP_ID),
      supportContact: configured(env.SUPPORT_CONTACT),
    },
    features: {
      mockTests: mockTestsEnabled(env),
    },
  };
}
