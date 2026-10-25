/**
 * The per-user open-ticket cap and the crash-recovery paths of ticket creation,
 * driven through scripted interleavings (tests/helpers/interleave.js) instead
 * of timing. In-memory models; tests/integration/supportTicketsMongo.test.js
 * runs the very same schedules against a real MongoDB.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import { makeSupportDeps, makeFakeBot, makeSessionClient } from "../helpers/fakeSupport.js";
import { CAP_SCENARIO_NAMES, runCapScenario, cleanupVersusTwin } from "../helpers/capScenarios.js";
import { RECOVERY_SCENARIO_NAMES, runRecoveryScenario } from "../helpers/recoveryScenarios.js";

process.env.ADMINS = "9001";
delete process.env.SUPPORT_GROUP_ALERTS;

const tickets = await import("../../services/support/tickets.js");
const workflow = await import("../../services/support/workflow.js");
const { setSessionClientForTests, clearSessionClientForTests } = await import("../../config/sessionStore.js");

let env;
beforeEach(() => {
  const deps = makeSupportDeps();
  tickets.setSupportModelsForTests(deps);
  setSessionClientForTests(makeSessionClient());
  env = { Ticket: deps.Ticket, Message: deps.Message, tickets, workflow, bot: makeFakeBot(), userBase: 3_000_000 };
});
afterEach(() => {
  tickets.clearSupportModelsForTests();
  clearSessionClientForTests();
});

describe("open-ticket cap under scripted interleavings", () => {
  for (const [index, name] of CAP_SCENARIO_NAMES.entries()) test(name, () => runCapScenario(env, index));
  test("a failed-create cleanup racing a twin that stored the message loses nothing acknowledged", () => cleanupVersusTwin(env));
});

describe("crash recovery and stale-state repair", () => {
  for (const [index, name] of RECOVERY_SCENARIO_NAMES.entries()) test(name, () => runRecoveryScenario(env, index));
});
