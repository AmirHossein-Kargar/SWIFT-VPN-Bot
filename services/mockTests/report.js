/**
 * Assertion recording and report shaping for mock-test runs.
 *
 * A scenario is PASS only when it executed at least one assertion and every
 * executed assertion passed. A thrown error, a failed assertion, or an
 * isolation violation makes it FAIL; an unmet precondition makes it BLOCKED;
 * a scenario that was never started is NOT RUN.
 */

export const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  BLOCKED: "BLOCKED",
  NOT_RUN: "NOT RUN",
});

const MAX_ASSERTIONS = 200;
const MAX_DETAIL = 240;

/** Redact anything that could be a credential, link, or long identifier. */
export function redact(value, limit = MAX_DETAIL) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(?:https?|vless|vmess|trojan|ss):\/\/\S+/gi, "[url]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .replace(/(secret|password|token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .trim()
    .slice(0, limit);
}

export class BlockedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "BlockedError";
  }
}

function describe(value) {
  if (value === undefined) return "undefined";
  if (value instanceof Date) return value.toISOString();
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function createScenarioRecorder({ id, title, titleFa }) {
  const assertions = [];
  const notes = [];
  const push = (entry) => {
    if (assertions.length < MAX_ASSERTIONS) assertions.push(entry);
  };
  return {
    id,
    title,
    titleFa,
    assertions,
    notes,
    check(name, condition, detail = "") {
      const ok = Boolean(condition);
      push({ name: redact(name, 160), status: ok ? "pass" : "fail", detail: ok ? "" : redact(detail) });
      return ok;
    },
    equal(name, actual, expected) {
      const ok = Object.is(actual, expected)
        || (actual instanceof Date && expected instanceof Date && actual.getTime() === expected.getTime());
      push({ name: redact(name, 160), status: ok ? "pass" : "fail", detail: ok ? "" : redact(`expected ${describe(expected)}, got ${describe(actual)}`) });
      return ok;
    },
    async rejects(name, fn, predicate = () => true) {
      try {
        await fn();
        push({ name: redact(name, 160), status: "fail", detail: "expected a rejection, but the call succeeded" });
        return false;
      } catch (error) {
        const ok = Boolean(predicate(error));
        push({ name: redact(name, 160), status: ok ? "pass" : "fail", detail: ok ? "" : redact(`unexpected error ${error?.name || "Error"}:${error?.code || ""}`) });
        return ok;
      }
    },
    skip(name, reason) {
      push({ name: redact(name, 160), status: "skipped", detail: redact(reason) });
    },
    note(text) {
      if (notes.length < 20) notes.push(redact(text, 400));
    },
    block(reason) {
      throw new BlockedError(reason);
    },
  };
}

export function finalizeScenario(recorder, { startedAt, completedAt, error = null, violations = [] }) {
  const failed = recorder.assertions.filter((entry) => entry.status === "fail");
  const executed = recorder.assertions.filter((entry) => entry.status !== "skipped");
  let status;
  let explanation = null;
  let errorDetail = null;

  if (error instanceof BlockedError) {
    status = STATUS.BLOCKED;
    explanation = redact(error.message, 400);
  } else if (error) {
    status = STATUS.FAIL;
    errorDetail = redact(`${error?.name || "Error"}${error?.code ? ` (${error.code})` : ""}: ${error?.message || ""}`);
    explanation = "The scenario stopped on an unexpected error before all assertions ran.";
  } else if (violations.length) {
    status = STATUS.FAIL;
    explanation = `Isolation violation: ${violations.slice(0, 5).join(", ")} was called during the mock run.`;
  } else if (failed.length) {
    status = STATUS.FAIL;
    explanation = `${failed.length} assertion(s) failed: ${failed.slice(0, 3).map((entry) => entry.name).join("; ")}`;
  } else if (!executed.length) {
    status = STATUS.BLOCKED;
    explanation = "No assertion was executed, so the outcome is not verified.";
  } else {
    status = STATUS.PASS;
  }

  return {
    id: recorder.id,
    title: recorder.title,
    titleFa: recorder.titleFa,
    status,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt - startedAt,
    assertions: recorder.assertions,
    counts: {
      total: recorder.assertions.length,
      passed: recorder.assertions.filter((entry) => entry.status === "pass").length,
      failed: failed.length,
      skipped: recorder.assertions.filter((entry) => entry.status === "skipped").length,
    },
    notes: recorder.notes,
    explanation,
    error: errorDetail,
    isolationViolations: violations.slice(0, 20),
  };
}

export function notRunScenario({ id, title, titleFa }, reason) {
  return {
    id,
    title,
    titleFa,
    status: STATUS.NOT_RUN,
    startedAt: null,
    completedAt: null,
    durationMs: 0,
    assertions: [],
    counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
    notes: [],
    explanation: redact(reason, 400),
    error: null,
    isolationViolations: [],
  };
}

export function summarize(scenarios) {
  const summary = { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT RUN": 0, assertions: 0, assertionsFailed: 0 };
  for (const scenario of scenarios) {
    summary[scenario.status] += 1;
    summary.assertions += scenario.counts.total;
    summary.assertionsFailed += scenario.counts.failed;
  }
  const overall = summary.FAIL ? STATUS.FAIL
    : summary.BLOCKED ? STATUS.BLOCKED
      : summary.PASS && !summary["NOT RUN"] ? STATUS.PASS
        : summary.PASS ? "PARTIAL" : STATUS.NOT_RUN;
  return { ...summary, overall };
}

export default { STATUS, redact, createScenarioRecorder, finalizeScenario, notRunScenario, summarize, BlockedError };
