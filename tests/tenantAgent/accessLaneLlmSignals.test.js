const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeAccessIntent,
} = require("../../src/adapters/tenantAgent/mergeAccessPartialFromLlm");

describe("LLM access intent normalization — lane control signals", () => {
  it("maps close → ACCESS_CLOSE", () => {
    assert.equal(normalizeAccessIntent("close"), "ACCESS_CLOSE");
    assert.equal(normalizeAccessIntent("access_close"), "ACCESS_CLOSE");
  });

  it("maps switch_maintenance → ACCESS_SWITCH_MAINTENANCE", () => {
    assert.equal(
      normalizeAccessIntent("switch_maintenance"),
      "ACCESS_SWITCH_MAINTENANCE"
    );
    assert.equal(
      normalizeAccessIntent("access_switch_maintenance"),
      "ACCESS_SWITCH_MAINTENANCE"
    );
    assert.equal(
      normalizeAccessIntent("maintenance"),
      "ACCESS_SWITCH_MAINTENANCE"
    );
  });

  it("unknown intents return empty", () => {
    assert.equal(normalizeAccessIntent("nonsense_value"), "");
    assert.equal(normalizeAccessIntent(""), "");
    assert.equal(normalizeAccessIntent(null), "");
  });
});
