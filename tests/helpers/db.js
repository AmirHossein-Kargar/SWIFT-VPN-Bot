/**
 * Test database helper.
 *
 * DB-backed tests run against a REAL MongoDB so that atomicity/idempotency
 * claims are actually exercised (a mocked driver proves nothing about
 * findOneAndUpdate semantics).
 *
 * Connection string resolution:
 *   1. TEST_MONGO_URL (preferred — point at a throwaway database)
 *   2. mongodb://127.0.0.1:27017/swiftvpn_test
 *
 * Safety: the helper refuses to run unless the database name contains "test",
 * so a misconfigured variable can never drop a production database.
 */
import mongoose from "mongoose";

const BASE_MONGO_URL =
  process.env.TEST_MONGO_URL || "mongodb://127.0.0.1:27017/swiftvpn_test";

/** Split a MongoDB URI into prefix / database name / query string. */
function splitMongoUrl(url) {
  const m = url.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/([^?]*))?(\?.*)?$/);
  if (!m) throw new Error("TEST_MONGO_URL is not a valid MongoDB URI");
  return { prefix: m[1], dbName: m[2] || "", query: m[3] || "" };
}

const { prefix, dbName, query } = splitMongoUrl(BASE_MONGO_URL);

if (!/test/i.test(dbName)) {
  throw new Error(
    `Refusing to run DB tests: database name "${dbName}" does not contain "test". ` +
      `Set TEST_MONGO_URL to a throwaway database.`
  );
}

// Node's test runner executes test FILES in parallel. Each file gets its own
// database so concurrent files cannot drop or mutate each other's fixtures.
const UNIQUE_DB_NAME = `${dbName}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

export const TEST_MONGO_URL = `${prefix}/${UNIQUE_DB_NAME}${query}`;

/**
 * Connect to the test database and wipe it.
 * @returns {Promise<boolean>} false when no MongoDB is reachable (tests should skip)
 */
export async function connectTestDB() {
  // Safety is enforced when TEST_MONGO_URL is computed above (module load).
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_MONGO_URL, { serverSelectionTimeoutMS: 5000 });
    }
    await mongoose.connection.db.dropDatabase();
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
    return true;
  } catch (err) {
    await mongoose.disconnect().catch(() => {});
    console.warn(`[tests] MongoDB unavailable — real-database integration tests are skipped (${err?.name || "ConnectionError"}).`);
    return false;
  }
}

/** Drop the test database and disconnect. */
export async function disconnectTestDB() {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
  } catch {
    /* best effort */
  }
}

/** Minimal Telegram bot stub for handlers that send messages. */
export function makeBotStub() {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, text, opts) => {
      sent.push({ kind: "message", chatId, text, opts });
      return { message_id: sent.length };
    },
    sendPhoto: async (chatId, photo, opts) => {
      sent.push({ kind: "photo", chatId, photo, opts });
      return { message_id: sent.length };
    },
    editMessageText: async (text, opts) => {
      sent.push({ kind: "edit", text, opts });
      return { message_id: opts?.message_id ?? 1 };
    },
    editMessageReplyMarkup: async () => ({ ok: true }),
    deleteMessage: async () => ({ ok: true }),
    answerCallbackQuery: async (id, opts) => { sent.push({ kind: "answer", id, opts }); return true; },
    stopPolling: async () => {},
    on: () => {},
    texts: () => sent.filter((s) => s.text).map((s) => s.text),
  };
}
