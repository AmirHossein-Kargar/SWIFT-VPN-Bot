/**
 * Customer sign-in for the web support area.
 *
 * Customers prove who they are by tapping a button INSIDE the Telegram bot:
 * Telegram has already authenticated that chat, so the bot mints a one-time,
 * short-lived login code and shows it as a link. The website never sends an
 * unsolicited Telegram message to an arbitrary id (no request-code endpoint),
 * which rules out using the login form to spam or probe other users.
 *
 * Sessions live in Redis under their own prefix and cookie, fully separate
 * from admin sessions: a customer session can never satisfy an admin check.
 */
import { createHash, randomBytes } from "node:crypto";
import redisClient, { isRedisReady } from "../../config/redisClient.js";

const LOGIN_CODE_TTL_SECONDS = 5 * 60;
const MINT_RATE_TTL_SECONDS = 30;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const SESSION_PREFIX = "support:web:session:";
const LOGIN_PREFIX = "support:web:login:";
const MINT_RATE_PREFIX = "support:web:mint-rate:";
const CONSUME_ONCE_LUA = `
  local value = redis.call('GET', KEYS[1])
  if value then redis.call('DEL', KEYS[1]) end
  return value
`;

export const CUSTOMER_SESSION_COOKIE = "swift_customer_session";

let injectedRedis = null;
export function setCustomerSessionRedisForTests(redis) { injectedRedis = redis; }
export function clearCustomerSessionRedisForTests() { injectedRedis = null; }
function store() { return injectedRedis || redisClient; }

function httpError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.safeMessage = message;
  return error;
}

function ready(redis) {
  if (!redis || (redis === redisClient && !isRedisReady())) {
    throw httpError("ورود به پنل پشتیبانی موقتاً در دسترس نیست.", "SESSION_STORE_UNAVAILABLE", 503);
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireTelegramId(telegramId) {
  const id = String(telegramId ?? "");
  if (!/^\d{1,20}$/.test(id)) throw httpError("حساب کاربری معتبر نیست.", "INVALID_USER", 400);
  return id;
}

/** Called only from a Telegram callback made by `telegramId` itself. */
export async function issueCustomerLoginCode(telegramId, redis = store()) {
  const id = requireTelegramId(telegramId);
  ready(redis);
  const rate = await redis.set(`${MINT_RATE_PREFIX}${id}`, "1", { NX: true, EX: MINT_RATE_TTL_SECONDS });
  if (rate !== "OK") throw httpError("لینک ورود به تازگی ارسال شده است. چند لحظه صبر کنید.", "LOGIN_RATE_LIMITED", 429);
  const code = randomBytes(24).toString("base64url");
  const saved = await redis.set(`${LOGIN_PREFIX}${digest(code)}`, id, { NX: true, EX: LOGIN_CODE_TTL_SECONDS });
  if (saved !== "OK") throw httpError("ایجاد لینک ورود ممکن نیست.", "LOGIN_UNAVAILABLE", 503);
  return { code, expiresInSeconds: LOGIN_CODE_TTL_SECONDS };
}

export async function consumeCustomerLoginCode(code, redis = store()) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(code)) return null;
  ready(redis);
  const value = await redis.eval(CONSUME_ONCE_LUA, { keys: [`${LOGIN_PREFIX}${digest(code)}`], arguments: [] });
  return typeof value === "string" && /^\d{1,20}$/.test(value) ? value : null;
}

export async function createCustomerSession(telegramId, redis = store()) {
  const id = requireTelegramId(telegramId);
  ready(redis);
  const token = randomBytes(32).toString("base64url");
  const session = {
    userTelegramId: id,
    csrfToken: randomBytes(32).toString("base64url"),
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  await redis.set(`${SESSION_PREFIX}${token}`, JSON.stringify(session), { EX: SESSION_TTL_SECONDS });
  return { token, session, ttlSeconds: SESSION_TTL_SECONDS };
}

export async function getCustomerSession(token, redis = store()) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  ready(redis);
  const raw = await redis.get(`${SESSION_PREFIX}${token}`);
  if (!raw) return null;
  let session;
  try { session = JSON.parse(raw); } catch { return null; }
  if (!session || !/^\d{1,20}$/.test(String(session.userTelegramId)) || Number(session.expiresAt) <= Date.now()) {
    await redis.del(`${SESSION_PREFIX}${token}`).catch(() => {});
    return null;
  }
  return session;
}

export async function deleteCustomerSession(token, redis = store()) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  ready(redis);
  await redis.del(`${SESSION_PREFIX}${token}`);
  return true;
}

export const CUSTOMER_SESSION_TTL_SECONDS = SESSION_TTL_SECONDS;
