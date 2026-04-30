const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  getLifecycleMessageSpec,
} = require("../src/outgate/lifecycleMessageSpecs");

describe("lifecycleMessageSpecs", () => {
  test("tenant verify has fallback body", () => {
    const s = getLifecycleMessageSpec("TENANT_VERIFY_RESOLUTION");
    assert.ok(s && s.fallbackText.length > 10);
  });
  test("unknown key → null", () => {
    assert.equal(getLifecycleMessageSpec("Nope"), null);
  });
});
