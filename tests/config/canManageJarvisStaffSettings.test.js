const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("canManageJarvisStaffSettings", () => {
  const prev = process.env.PROPERA_JARVIS_SETTINGS_ADMIN_EMAILS;

  it("allows only allowlisted jwt emails", () => {
    process.env.PROPERA_JARVIS_SETTINGS_ADMIN_EMAILS = "admin@example.com,owner@test.com";
    delete require.cache[require.resolve("../../src/config/env")];
    const { canManageJarvisStaffSettings } = require("../../src/config/env");

    assert.equal(
      canManageJarvisStaffSettings({ source: "jwt", emailLower: "admin@example.com" }),
      true
    );
    assert.equal(
      canManageJarvisStaffSettings({ source: "jwt", emailLower: "other@example.com" }),
      false
    );
    assert.equal(canManageJarvisStaffSettings({ source: "default", emailLower: "admin@example.com" }), false);
  });

  it("denies everyone when env empty", () => {
    process.env.PROPERA_JARVIS_SETTINGS_ADMIN_EMAILS = "";
    delete require.cache[require.resolve("../../src/config/env")];
    const { canManageJarvisStaffSettings } = require("../../src/config/env");
    assert.equal(
      canManageJarvisStaffSettings({ source: "jwt", emailLower: "admin@example.com" }),
      false
    );
  });

  after(() => {
    if (prev === undefined) delete process.env.PROPERA_JARVIS_SETTINGS_ADMIN_EMAILS;
    else process.env.PROPERA_JARVIS_SETTINGS_ADMIN_EMAILS = prev;
    delete require.cache[require.resolve("../../src/config/env")];
  });
});

function after(fn) {
  process.on("exit", fn);
}
