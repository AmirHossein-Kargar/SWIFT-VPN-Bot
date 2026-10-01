/**
 * Authorization tests — these import the REAL utils/auth.js.
 *
 * Regression guard for the fail-open bug where an empty/unset ADMINS list made
 * every caller an admin.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getAdminIds, isAdminUser, isAdminGroup, isAdmin } from "../../utils/auth.js";

const ORIGINAL = {
  ADMINS: process.env.ADMINS,
  GROUP_ID: process.env.GROUP_ID,
};

function restore() {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("utils/auth — admin policy is fail-CLOSED", () => {
  beforeEach(restore);
  afterEach(restore);

  test("unset ADMINS => nobody is an admin", () => {
    delete process.env.ADMINS;
    assert.deepEqual(getAdminIds(), []);
    assert.equal(isAdminUser(123), false);
    assert.equal(isAdminUser("123"), false);
  });

  test("empty ADMINS => nobody is an admin", () => {
    process.env.ADMINS = "";
    assert.equal(isAdminUser(123), false);
  });

  test("malformed ADMINS entries are dropped, not fatal", () => {
    process.env.ADMINS = "abc, ,42,xyz, ,7";
    assert.deepEqual(getAdminIds(), [42, 7]);
    assert.equal(isAdminUser(42), true);
    assert.equal(isAdminUser(7), true);
    assert.equal(isAdminUser(99), false);
  });

  test("ADMINS with only garbage => nobody is an admin", () => {
    process.env.ADMINS = "not-a-number,also-bad";
    assert.deepEqual(getAdminIds(), []);
    assert.equal(isAdminUser(123), false);
  });

  test("whitespace around ids is tolerated", () => {
    process.env.ADMINS = "  111 ,  222  ";
    assert.deepEqual(getAdminIds(), [111, 222]);
  });

  test("isAdminGroup is fail-closed when GROUP_ID is unset", () => {
    delete process.env.GROUP_ID;
    assert.equal(isAdminGroup(-100123), false);
  });

  test("isAdminGroup matches only the configured chat", () => {
    process.env.GROUP_ID = "-100999";
    assert.equal(isAdminGroup(-100999), true);
    assert.equal(isAdminGroup("-100999"), true);
    assert.equal(isAdminGroup(-100111), false);
    assert.equal(isAdminGroup(12345), false);
  });

  test("isAdmin requires BOTH a configured admin and the admin group", () => {
    process.env.ADMINS = "555";
    process.env.GROUP_ID = "-100999";

    assert.equal(isAdmin(-100999, 555), true, "admin inside the group");
    assert.equal(isAdmin(-100999, 556), false, "non-admin inside the group");
    assert.equal(isAdmin(12345, 555), false, "admin outside the group (forged callback)");
    assert.equal(isAdmin(12345, 556), false, "non-admin outside the group");
  });

  test("isAdmin without GROUP_ID only checks the admin list", () => {
    process.env.ADMINS = "555";
    delete process.env.GROUP_ID;
    assert.equal(isAdmin(12345, 555), true);
    assert.equal(isAdmin(12345, 556), false);
  });
});
