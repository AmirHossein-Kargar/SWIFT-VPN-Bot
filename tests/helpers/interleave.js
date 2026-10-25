/**
 * Deterministic interleaving of concurrent support-ticket creators.
 *
 * Each creator runs inside `run(name, fn)`. The wrapped model operations
 * (`create`, `count`, `delete`, `msg`, `mcount`) park at a numbered label such
 * as "A:create#1" until the test releases it with `step()`. A step returns only
 * after that operation has COMPLETED against the model, so the order in which
 * the database sees the operations is exactly the order of the steps, on the
 * in-memory fakes and on a real MongoDB alike.
 *
 * `crashAt(label)` makes that operation throw instead of running, which models
 * a process dying right before it. `finish()` lets everything still parked run
 * freely and waits for every creator.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export function makeInterleaver() {
  const als = new AsyncLocalStorage();
  const counters = new Map();
  const parked = new Map();
  const completed = new Set();
  const crashes = new Set();
  const trace = [];
  const runs = [];
  let free = false;

  const nextLabel = (op) => {
    const key = `${als.getStore() ?? "?"}:${op}`;
    const n = (counters.get(key) || 0) + 1;
    counters.set(key, n);
    return `${key}#${n}`;
  };

  const gate = async (label) => {
    if (free) return;
    await new Promise((resolve) => parked.set(label, resolve));
  };

  const until = async (predicate, what) => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`interleaver timed out waiting for ${what}; trace: ${trace.join(" ")}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  /** Wraps `model[method]` so each call parks at "<creator>:<op>#<n>" before it touches the model. */
  function wrap(model, method, op, restores) {
    const real = model[method];
    restores.push(() => { model[method] = real; });
    model[method] = async function interleaved(...args) {
      const label = nextLabel(op);
      await gate(label);
      trace.push(label);
      try {
        if (crashes.has(label)) throw Object.assign(new Error(`injected crash at ${label}`), { code: "EINJECTED" });
        return await real.apply(this, args);
      } finally {
        completed.add(label);
      }
    };
  }

  return {
    trace,
    wrap,
    crashAt: (label) => crashes.add(label),
    /** Starts a creator; its result is collected by finish(). */
    run(name, fn) {
      const promise = als.run(name, fn);
      runs.push({ name, promise: promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })) });
      return promise;
    },
    /** Releases the labels in order, each one only after the previous operation completed. */
    async step(...labels) {
      for (const label of labels) {
        await until(() => parked.has(label), `${label} to arrive`);
        parked.get(label)();
        parked.delete(label);
        await until(() => completed.has(label), `${label} to complete`);
      }
    },
    async finish() {
      free = true;
      for (const [label, release] of parked) { release(); parked.delete(label); }
      const results = {};
      for (const { name, promise } of runs) results[name] = await promise;
      return results;
    },
  };
}
