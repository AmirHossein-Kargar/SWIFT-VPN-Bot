/**
 * IRANYekanX is the primary font of both applications and is served from web/public/store/fonts
 * exactly like any other static asset, in production too (the earlier "development only" block in
 * web/spa.js was removed on purpose). The file itself is gitignored and proprietary: where it is
 * absent the page falls back to Vazirmatn, which must keep being served.
 *
 * (The file name is historical: it first held the opposite, production-blocking, test.)
 * The test uses a throw-away file under the real static root and removes only that file.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as spa from "../../web/spa.js";

const fontsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public", "store", "fonts");
const probe = path.join(fontsDir, "iranyekanx-unit-test-probe.woff2");
const probeExisted = fs.existsSync(probe);

describe("IRANYekanX static serving", () => {
  let server; let base; const previousEnv = process.env.NODE_ENV;
  before(async () => {
    if (!probeExisted) fs.writeFileSync(probe, "wOF2-probe");
    const app = express();
    app.use(spa.serveAdminSpa);
    app.use((req, res) => res.status(404).end("not found"));
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    process.env.NODE_ENV = previousEnv;
    if (!probeExisted) fs.rmSync(probe, { force: true });
    await new Promise((resolve) => server.close(resolve));
  });

  test("no environment-specific block remains in the static server", () => {
    assert.equal(spa.isLocalPreviewOnlyAsset, undefined);
  });

  test("the font is served in production and in development, as woff2", async () => {
    for (const env of ["production", "development"]) {
      process.env.NODE_ENV = env;
      const response = await fetch(`${base}/store/fonts/iranyekanx-unit-test-probe.woff2`);
      assert.equal(response.status, 200, env);
      assert.match(response.headers.get("content-type"), /^font\/woff2/, env);
    }
  });

  test("the Vazirmatn fallback and its OFL licence are still served in production", async () => {
    process.env.NODE_ENV = "production";
    assert.equal((await fetch(`${base}/store/fonts/vazirmatn-arabic-wght-normal.woff2`)).status, 200);
    assert.equal((await fetch(`${base}/store/fonts/OFL.txt`)).status, 200);
  });
});
