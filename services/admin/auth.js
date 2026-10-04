import { createHash, randomBytes } from "node:crypto";
import redisClient, { isRedisReady } from "../../config/redisClient.js";
import { isAdminUser } from "../../utils/auth.js";

const LOGIN_CODE_TTL_SECONDS = 5 * 60;
const LOGIN_RATE_TTL_SECONDS = 45;
const SESSION_PREFIX = "admin:web:session:";
const LOGIN_PREFIX = "admin:web:login:";
const LOGIN_RATE_PREFIX = "admin:web:login-rate:";
const CONSUME_ONCE_LUA = `
  local value = redis.call('GET', KEYS[1])
  if value then redis.call('DEL', KEYS[1]) end
  return value
`;

// Test seam: allows the HTTP integration suite to run the full session flow
// without a live Redis (production always uses the shared redisClient).
let injectedRedis = null;
export function setAdminSessionRedisForTests(redis) { injectedRedis = redis; }
export function clearAdminSessionRedisForTests() { injectedRedis = null; }
function store() { return injectedRedis || redisClient; }

function sessionTtl() {
  const configured = Number(process.env.ADMIN_SESSION_TTL_SECONDS || 28_800);
  return Number.isInteger(configured) && configured >= 900 && configured <= 86_400
    ? configured
    : 28_800;
}

function ready(redis = redisClient) {
  if (!redis || (redis === redisClient && !isRedisReady())) {
    const error = new Error("ورود مدیریت به مخزن نشست Redis نیاز دارد.");
    error.code = "ADMIN_SESSION_STORE_UNAVAILABLE";
    error.status = 503;
    error.safeMessage = error.message;
    throw error;
  }
}

function httpError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.safeMessage = message;
  return error;
}

function digestCode(code) {
  return createHash("sha256").update(code).digest("hex");
}

export async function issueAdminLoginCode(telegramId, redis = store()) {
  if (!isAdminUser(telegramId)) {
    throw httpError("این حساب تلگرام برای دسترسی مدیریتی مجاز نیست.", "FORBIDDEN", 403);
  }
  ready(redis);
  const id = String(telegramId);
  const rateKey = `${LOGIN_RATE_PREFIX}${id}`;
  const rate = await redis.set(rateKey, "1", { NX: true, EX: LOGIN_RATE_TTL_SECONDS });
  if (rate !== "OK") {
    throw httpError("کد ورود به تازگی ارسال شده است. برای درخواست جدید کمی صبر کنید.", "LOGIN_CODE_RATE_LIMITED", 429);
  }

  const code = randomBytes(24).toString("base64url");
  const key = `${LOGIN_PREFIX}${digestCode(code)}`;
  const saved = await redis.set(key, id, { NX: true, EX: LOGIN_CODE_TTL_SECONDS });
  if (saved !== "OK") {
    throw httpError("ایجاد کد ورود در حال حاضر ممکن نیست.", "LOGIN_CODE_UNAVAILABLE", 503);
  }
  return { code, expiresInSeconds: LOGIN_CODE_TTL_SECONDS };
}

export async function consumeAdminLoginCode(code, redis = store()) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(code)) return null;
  ready(redis);
  const key = `${LOGIN_PREFIX}${digestCode(code)}`;
  const value = await redis.eval(CONSUME_ONCE_LUA, { keys: [key], arguments: [] });
  if (typeof value !== "string" || !isAdminUser(value)) return null;
  return String(value);
}

export async function createAdminSession(telegramId, redis = store(), { ttlSeconds = sessionTtl() } = {}) {
  if (!isAdminUser(telegramId)) {
    throw httpError("این حساب تلگرام برای دسترسی مدیریتی مجاز نیست.", "FORBIDDEN", 403);
  }
  ready(redis);
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const now = Date.now();
  const session = {
    actorTelegramId: String(telegramId),
    csrfToken,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
  };
  await redis.set(`${SESSION_PREFIX}${token}`, JSON.stringify(session), { EX: ttlSeconds });
  return { token, session, ttlSeconds };
}

export async function getAdminSession(token, redis = store()) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  ready(redis);
  const raw = await redis.get(`${SESSION_PREFIX}${token}`);
  if (!raw) return null;
  let session;
  try { session = JSON.parse(raw); } catch { return null; }
  if (!session || typeof session !== "object" || !isAdminUser(session.actorTelegramId) || Number(session.expiresAt) <= Date.now()) {
    await redis.del(`${SESSION_PREFIX}${token}`).catch(() => {});
    return null;
  }
  return session;
}

export async function deleteAdminSession(token, redis = store()) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  ready(redis);
  await redis.del(`${SESSION_PREFIX}${token}`);
  return true;
}

export const ADMIN_SESSION_COOKIE = "swift_admin_session";
export const ADMIN_SESSION_TTL_SECONDS = sessionTtl;
export const ADMIN_SESSION_PREFIX = SESSION_PREFIX;
export const LOGIN_CODE_TTL = LOGIN_CODE_TTL_SECONDS;
