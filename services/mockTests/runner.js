/**
 * Mock-test runner: the single entry point used by the Telegram admin panel
 * and the web dashboard.
 *
 * Safety model
 *  - Server-side gate: runs only when MOCK_TESTS_ENABLED=true is set in the
 *    server environment AND the actor passes the admin allowlist check. No
 *    request field can switch mock mode on.
 *  - Every scenario receives in-memory models and fake provider adapters, and
 *    executes inside an isolation context where the real Mongoose models,
 *    HTTP(S) and fetch throw (see isolation.js). Violations fail the scenario.
 *  - One run at a time per process; a run never writes to financial
 *    collections. Only the report is persisted, in its own collection.
 */
import { randomBytes } from "node:crypto";
import MockTestRun from "../../models/MockTestRun.js";
import { assertAdminUser, AdminServiceError } from "../admin/authorization.js";
import { runAuditedAction } from "../admin/audit.js";
import { installIsolationGuards, runIsolated } from "./isolation.js";
import { BlockedError, createScenarioRecorder, finalizeScenario, notRunScenario, redact, summarize, STATUS } from "./report.js";
import { purchaseScenario } from "./scenarios/purchase.js";
import { cryptoScenario } from "./scenarios/crypto.js";
import { cardToCardScenario } from "./scenarios/cardToCard.js";
import { testServiceScenario } from "./scenarios/testService.js";

export const MOCK_SCENARIOS = Object.freeze([purchaseScenario, cryptoScenario, cardToCardScenario, testServiceScenario]);
const SCENARIO_BY_ID = new Map(MOCK_SCENARIOS.map((scenario) => [scenario.id, scenario]));
const RECENT_LIMIT = 20;
const MIN_INTERVAL_MS = 5_000;

const recentRuns = [];
let activeRun = null;
let lastRunStartedAt = 0;

export function mockTestsEnabled(env = process.env) {
  return String(env.MOCK_TESTS_ENABLED ?? "").trim().toLowerCase() === "true";
}

export function listMockScenarios() {
  return MOCK_SCENARIOS.map(({ id, title, titleFa }) => ({ id, title, titleFa }));
}

function newRunId(now = new Date()) {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `MT-${stamp}-${randomBytes(4).toString("hex")}`;
}

function resolveScenarios(requested) {
  if (requested == null || requested === "all" || (Array.isArray(requested) && requested.length === 0)) return [...MOCK_SCENARIOS];
  const ids = Array.isArray(requested) ? requested : [requested];
  if (ids.length > MOCK_SCENARIOS.length || !ids.every((id) => typeof id === "string" && SCENARIO_BY_ID.has(id))) {
    throw new AdminServiceError("سناریوی تست ماک نامعتبر است.", { status: 400, code: "invalid_mock_scenario" });
  }
  return [...new Set(ids)].map((id) => SCENARIO_BY_ID.get(id));
}

function remember(report) {
  recentRuns.unshift(report);
  recentRuns.splice(RECENT_LIMIT);
}

async function persist(report, runModel) {
  try {
    await runModel.create({
      runId: report.runId,
      environment: report.environment,
      actorTelegramId: report.actorTelegramId,
      trigger: report.trigger,
      requestedScenarios: report.requestedScenarios,
      startedAt: new Date(report.startedAt),
      completedAt: new Date(report.completedAt),
      summary: report.summary,
      scenarios: report.scenarios,
    });
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), service: "mock-tests", level: "warn",
      message: "Mock-test report could not be persisted; kept in memory only",
      runId: report.runId, errorType: error?.name || "Error",
    }));
    return false;
  }
}

async function executeScenario(scenario, { runId, actorId }) {
  const recorder = createScenarioRecorder(scenario);
  const startedAt = new Date();
  let error = null;
  let violations = [];
  try {
    const outcome = await runIsolated({ runId, scenario: scenario.id }, () => scenario.run(recorder, { actorId, runId }));
    violations = outcome.violations;
  } catch (caught) {
    error = caught;
    violations = caught?.isolationViolations || [];
  }
  return finalizeScenario(recorder, { startedAt, completedAt: new Date(), error, violations });
}

/**
 * Execute the requested scenarios and return a structured report.
 * @param {object} options
 * @param {string|number} options.actorId  Authenticated admin Telegram ID.
 * @param {"telegram"|"web"|"test"} options.trigger
 * @param {string|string[]} [options.scenarios]  Scenario IDs or "all".
 */
export async function runMockTests({
  actorId,
  trigger,
  scenarios: requested = "all",
  env = process.env,
  runModel = MockTestRun,
  auditModel,
  now = () => new Date(),
} = {}) {
  const actor = assertAdminUser(actorId);
  if (!["telegram", "web", "test"].includes(trigger)) {
    throw new AdminServiceError("منبع اجرای تست نامعتبر است.", { status: 400, code: "invalid_mock_trigger" });
  }
  const selected = resolveScenarios(requested);
  const runId = newRunId(now());
  const base = {
    runId,
    environment: "mock-isolated",
    actorTelegramId: actor,
    trigger,
    requestedScenarios: selected.map((scenario) => scenario.id),
  };

  if (!mockTestsEnabled(env)) {
    const at = now().toISOString();
    const scenarios = MOCK_SCENARIOS.map((scenario) => notRunScenario(scenario,
      "Mock testing is disabled on this server (set MOCK_TESTS_ENABLED=true in the server environment to allow runs)."));
    return { ...base, enabled: false, startedAt: at, completedAt: at, scenarios, summary: summarize(scenarios), persisted: false };
  }
  if (activeRun) {
    throw new AdminServiceError("یک اجرای تست ماک در حال انجام است؛ پس از پایان آن دوباره تلاش کنید.", { status: 409, code: "mock_run_in_progress" });
  }
  if (Date.now() - lastRunStartedAt < MIN_INTERVAL_MS) {
    throw new AdminServiceError("اجرای تست ماک به‌تازگی انجام شده است؛ چند ثانیه صبر کنید.", { status: 429, code: "mock_run_rate_limited" });
  }

  activeRun = runId;
  lastRunStartedAt = Date.now();
  try {
    const { result } = await runAuditedAction({
      actorTelegramId: actor,
      operationId: runId,
      action: "MOCK_TEST_RUN",
      targetType: "mock_test",
      targetId: runId,
      metadata: { trigger, scenarios: base.requestedScenarios },
      ...(auditModel ? { auditModel } : {}),
      execute: async () => {
        const startedAt = now();
        let guardsReady = true;
        try {
          await installIsolationGuards();
        } catch {
          guardsReady = false;
        }
        const scenarios = [];
        for (const scenario of MOCK_SCENARIOS) {
          if (!selected.includes(scenario)) {
            scenarios.push(notRunScenario(scenario, "Not selected for this run."));
          } else if (!guardsReady) {
            const at = new Date();
            scenarios.push(finalizeScenario(createScenarioRecorder(scenario), {
              startedAt: at, completedAt: at,
              error: new BlockedError("Isolation guards could not be installed, so the scenario was not executed."),
            }));
          } else {
            scenarios.push(await executeScenario(scenario, { runId, actorId: actor }));
          }
        }
        const report = {
          ...base,
          enabled: true,
          startedAt: startedAt.toISOString(),
          completedAt: now().toISOString(),
          scenarios,
          summary: summarize(scenarios),
        };
        return { report, auditSummary: { overall: report.summary.overall, pass: report.summary.PASS, fail: report.summary.FAIL, blocked: report.summary.BLOCKED } };
      },
    });
    const report = result.report;
    remember(report);
    report.persisted = await persist(report, runModel);
    return report;
  } finally {
    activeRun = null;
  }
}

function publicReport(doc) {
  if (!doc) return null;
  return {
    runId: doc.runId,
    environment: doc.environment,
    actorTelegramId: doc.actorTelegramId,
    trigger: doc.trigger,
    requestedScenarios: doc.requestedScenarios || [],
    startedAt: doc.startedAt instanceof Date ? doc.startedAt.toISOString() : doc.startedAt,
    completedAt: doc.completedAt instanceof Date ? doc.completedAt.toISOString() : doc.completedAt,
    summary: doc.summary || {},
    scenarios: doc.scenarios || [],
  };
}

export async function listMockRuns({ actorId, limit = 10, runModel = MockTestRun } = {}) {
  assertAdminUser(actorId);
  const size = Math.max(1, Math.min(50, Number(limit) || 10));
  let items = null;
  let source = "database";
  try {
    items = await runModel.find({}).sort({ startedAt: -1 }).limit(size).lean();
  } catch {
    items = null;
  }
  if (!items) {
    source = "memory";
    items = recentRuns.slice(0, size);
  }
  return {
    enabled: mockTestsEnabled(),
    running: Boolean(activeRun),
    source,
    scenarios: listMockScenarios(),
    items: items.map((item) => {
      const report = publicReport(item);
      return { ...report, scenarios: report.scenarios.map(({ id, title, titleFa, status, counts, explanation }) => ({ id, title, titleFa, status, counts, explanation })) };
    }),
  };
}

export async function getMockRun({ actorId, runId, runModel = MockTestRun } = {}) {
  assertAdminUser(actorId);
  if (typeof runId !== "string" || !/^MT-\d{14}-[0-9a-f]{8}$/.test(runId)) {
    throw new AdminServiceError("شناسه اجرای تست نامعتبر است.", { status: 400, code: "invalid_mock_run_id" });
  }
  let doc = null;
  try {
    doc = await runModel.findOne({ runId }).lean();
  } catch {
    doc = null;
  }
  doc ||= recentRuns.find((report) => report.runId === runId) || null;
  if (!doc) throw new AdminServiceError("گزارش تست یافت نشد.", { status: 404, code: "mock_run_not_found" });
  return publicReport(doc);
}

/** Compact Persian summary for Telegram (well under the 4096-character limit). */
export function formatReportForTelegram(report, { escape = (value) => String(value) } = {}) {
  const icon = { PASS: "✅", FAIL: "❌", BLOCKED: "⛔️", "NOT RUN": "⏸" };
  const lines = [
    "🧪 <b>گزارش تست ماک</b>",
    `شناسه اجرا: <code>${escape(report.runId)}</code>`,
    "محیط: <b>ایزوله (بدون پرداخت، شارژ یا سرویس واقعی)</b>",
    "",
  ];
  for (const scenario of report.scenarios) {
    const counts = scenario.counts.total
      ? ` — ${scenario.counts.passed}/${scenario.counts.total - scenario.counts.skipped} بررسی${scenario.counts.skipped ? `، ${scenario.counts.skipped} رد شده` : ""}`
      : "";
    lines.push(`${icon[scenario.status] || "•"} <b>${escape(scenario.titleFa)}</b>: ${escape(scenario.status)}${counts}`);
    if (scenario.status !== STATUS.PASS && scenario.explanation) {
      lines.push(`   └ ${escape(redact(scenario.explanation, 220))}`);
    }
    if (scenario.error) lines.push(`   └ <code>${escape(redact(scenario.error, 160))}</code>`);
  }
  const s = report.summary;
  lines.push("", `نتیجه کلی: <b>${escape(s.overall)}</b> · موفق ${s.PASS} · ناموفق ${s.FAIL} · مسدود ${s.BLOCKED} · اجرا نشده ${s["NOT RUN"]}`);
  if (report.startedAt && report.completedAt) {
    lines.push(`مدت اجرا: ${Math.max(0, new Date(report.completedAt) - new Date(report.startedAt))} ms`);
  }
  if (report.enabled === false) lines.push("", "⚠️ اجرای تست ماک روی این سرور غیرفعال است (MOCK_TESTS_ENABLED).");
  else if (report.persisted === false) lines.push("", "⚠️ گزارش فقط در حافظه نگه داشته شد (ذخیره در پایگاه داده ناموفق بود).");
  return lines.join("\n").slice(0, 3900);
}

export function resetMockRunnerForTests() {
  recentRuns.length = 0;
  activeRun = null;
  lastRunStartedAt = 0;
}

export default { runMockTests, listMockRuns, getMockRun, listMockScenarios, mockTestsEnabled, formatReportForTelegram, MOCK_SCENARIOS };
