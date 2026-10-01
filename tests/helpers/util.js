/** Poll `fn` until it returns truthy or the timeout elapses. */
export async function waitFor(fn, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Collect console.log output produced by a function (used to assert on logs). */
export function captureLogs() {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return {
    lines,
    restore() {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
    has: (needle) => lines.some((l) => l.includes(needle)),
    count: (needle) => lines.filter((l) => l.includes(needle)).length,
  };
}
