import mongoose from "mongoose";
import { resolveMongoUrl } from "./env.js";
import { LegacyIndexConflictError, migrateLegacyIndexes } from "./mongoIndexMigration.js";
import {
  MONGO_STARTUP_STAGES,
  StartupDependencyError,
  safeErrorCode,
  safeErrorDetail,
} from "./startupDiagnostics.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Disconnect without ever masking the original startup failure. */
async function disconnectQuietly(mongooseInstance) {
  try {
    await mongooseInstance.disconnect();
  } catch {
    /* best effort — the startup failure is the interesting one */
  }
}

/**
 * Connect, verify and prepare MongoDB.
 *
 * Every step is reported separately so a failure is attributable without
 * ever printing a connection string, credentials or payment data:
 *
 *   mongo_config      → the MongoDB environment variables are missing/invalid
 *   mongo_connect     → the driver could not reach the server
 *   mongo_ping        → the server was reached but did not answer a ping
 *   index_migration   → the legacy HooshPay index could not be replaced
 *   index_init        → the required indexes could not be created
 *
 * Every failure disconnects the driver again, so a failed startup never
 * leaves a half-open connection behind.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {object} [options.logger]
 * @param {object} [options.mongooseInstance] Injectable driver (tests).
 */
export async function connectDB({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
  mongooseInstance = mongoose,
} = {}) {
  let resolved;
  try {
    resolved = resolveMongoUrl();
  } catch (error) {
    throw new StartupDependencyError(
      MONGO_STARTUP_STAGES.CONFIG,
      `MongoDB configuration is invalid (${safeErrorDetail(error)}). Fix the MongoDB environment variables.`,
      { cause: error, code: safeErrorCode(error), dependency: "mongodb" }
    );
  }
  if (!resolved) {
    throw new StartupDependencyError(
      MONGO_STARTUP_STAGES.CONFIG,
      "MongoDB is not configured; set MONGO_URL or the Railway MongoDB connection variables.",
      { dependency: "mongodb" }
    );
  }

  try {
    await mongooseInstance.connect(resolved.url, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
      maxPoolSize: 20,
      minPoolSize: 0,
      autoIndex: process.env.NODE_ENV !== "production",
    });
  } catch (error) {
    await disconnectQuietly(mongooseInstance);
    throw new StartupDependencyError(
      MONGO_STARTUP_STAGES.CONNECT,
      `MongoDB connection failed (${resolved.source}; ${safeErrorDetail(error)}). Check the Railway database reference, network access, and credentials.`,
      { cause: error, code: safeErrorCode(error), dependency: "mongodb" }
    );
  }

  try {
    await mongooseInstance.connection.db.command({ ping: 1 });
  } catch (error) {
    await disconnectQuietly(mongooseInstance);
    throw new StartupDependencyError(
      MONGO_STARTUP_STAGES.PING,
      `MongoDB ping failed (${resolved.source}; ${safeErrorDetail(error)}). The server was reached but did not answer a ping.`,
      { cause: error, code: safeErrorCode(error), dependency: "mongodb" }
    );
  }

  // Replace the legacy HooshPay `uid` index before any index is created:
  // MongoDB refuses to redefine an existing index, so the legacy (unique but
  // NOT sparse) index would make index creation fail on every startup.
  try {
    await migrateLegacyIndexes({
      db: mongooseInstance.connection.db,
      models: mongooseInstance.models,
      logger,
    });
  } catch (error) {
    await disconnectQuietly(mongooseInstance);
    // A conflict carries its own (already sanitized) explanation: it names
    // the index that has to be reconciled by hand.
    const message =
      error instanceof LegacyIndexConflictError
        ? error.message
        : `MongoDB index migration failed (${resolved.source}; ${safeErrorDetail(error)}). The legacy HooshPay index was not replaced — review the index definitions manually.`;
    throw new StartupDependencyError(
      MONGO_STARTUP_STAGES.INDEX_MIGRATION,
      message,
      { cause: error, code: safeErrorCode(error), dependency: "mongodb" }
    );
  }

  // Create missing indexes without dropping existing ones. Unique user IDs,
  // payment IDs, and on-chain transaction hashes are part of the money-safety
  // model, so production must not silently run without them.
  try {
    await Promise.all(
      mongooseInstance.modelNames().map((name) => mongooseInstance.model(name).createIndexes())
    );
  } catch (error) {
    await disconnectQuietly(mongooseInstance);
    throw new StartupDependencyError(
      MONGO_STARTUP_STAGES.INDEX_INIT,
      `MongoDB index initialization failed (${resolved.source}; ${safeErrorDetail(error)}). A required unique index could not be created — startup was stopped.`,
      { cause: error, code: safeErrorCode(error), dependency: "mongodb" }
    );
  }

  logger.log?.(`MongoDB connected and indexes checked (configuration: ${resolved.source})`);
  return mongooseInstance.connection;
}

export { MONGO_STARTUP_STAGES, StartupDependencyError };
export default connectDB;
