/**
 * Sanitized startup diagnostics.
 *
 * A startup failure has to be *attributable*: an operator reading the Railway
 * logs must be able to tell apart "MongoDB was unreachable", "the connection
 * was accepted but the ping failed", "the legacy index migration refused to
 * run" and "index creation failed" — without the log ever containing a
 * connection string, credentials, or payment data.
 *
 * Rules enforced by this module:
 *   • only a fixed vocabulary of stage names is ever emitted;
 *   • only an error NAME and a driver CODE are copied out of a raw error;
 *   • raw error MESSAGES are never copied — MongoDB/Redis drivers embed hosts,
 *     usernames and passwords in them — they stay on `cause` for local
 *     debugging only and are never logged by the startup path.
 */

/** MongoDB startup stages, in the order the bootstrap runs them. */
export const MONGO_STARTUP_STAGES = Object.freeze({
  CONFIG: "mongo_config",
  CONNECT: "mongo_connect",
  PING: "mongo_ping",
  INDEX_MIGRATION: "index_migration",
  INDEX_INIT: "index_init",
});

/** Redis startup stages. */
export const REDIS_STARTUP_STAGES = Object.freeze({
  CONFIG: "redis_config",
  CONNECT: "redis_connect",
});

/**
 * Error raised by the startup path. It carries a stage (what failed) and a
 * dependency (which service failed) so the failure can be attributed without
 * leaking anything about the connection itself.
 */
export class StartupDependencyError extends Error {
  constructor(stage, message, { cause, code, dependency, errorType } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "StartupDependencyError";
    this.stage = stage;
    this.dependency = dependency || "unknown";
    if (code !== undefined) this.code = code;
    this.errorType = errorType || (cause ? safeErrorName(cause) : undefined);
  }
}

/** Error name, trimmed and length-limited so it is safe to log. */
export function safeErrorName(error) {
  const name = error?.name;
  if (typeof name !== "string") return "Error";
  const trimmed = name.trim();
  if (!trimmed) return "Error";
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

/** Driver error code, when it is a string or a number. */
export function safeErrorCode(error) {
  const code = error?.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

/**
 * "MongooseServerSelectionError (code 85)" — the only part of a raw error
 * that is safe to put in a log line.
 */
export function safeErrorDetail(error) {
  const code = safeErrorCode(error);
  return code === undefined
    ? safeErrorName(error)
    : `${safeErrorName(error)} (code ${code})`;
}

/**
 * Attach stage/dependency metadata to an error that does not carry it yet.
 * Used for dependencies that throw plain errors (Redis), so every startup
 * failure is attributed the same way.
 */
export function withStartupStage(error, stage, dependency) {
  if (error && typeof error === "object") {
    if (!error.stage) error.stage = stage;
    if (!error.dependency) error.dependency = dependency;
    if (!error.errorType) error.errorType = safeErrorName(error);
  }
  return error;
}
