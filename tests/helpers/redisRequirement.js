/**
 * Redis-dependent tests (the broadcast lease) normally run only when a DISPOSABLE loopback Redis is configured via REDIS_URL
 * and are reported as skipped otherwise. The designated release verification (scripts/test-release.mjs) sets
 * REQUIRE_REDIS_TESTS=1, which turns "not configured" into a hard failure so a skip can never pass for a pass.
 */
export function redisTestsConfigured() {
  const configured = Boolean(process.env.REDIS_URL);
  if (!configured && process.env.REQUIRE_REDIS_TESTS === "1") {
    throw new Error("REQUIRE_REDIS_TESTS=1 but REDIS_URL is not set: the Redis-dependent tests are required here and cannot be skipped. Point REDIS_URL at a disposable loopback Redis.");
  }
  return configured;
}
