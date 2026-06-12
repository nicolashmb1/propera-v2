const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { shouldNotifyTenantAccessEvent } = require("../../src/dal/accessEngine");

describe("shouldNotifyTenantAccessEvent", () => {
  it("staff_override sends confirmation to tenant", () => {
    assert.equal(
      shouldNotifyTenantAccessEvent("staff_override", "ACCESS_TENANT_RESERVATION_CONFIRMED"),
      true
    );
  });

  it("tenant_portal skips confirmation sms", () => {
    assert.equal(
      shouldNotifyTenantAccessEvent("tenant_portal", "ACCESS_TENANT_RESERVATION_CONFIRMED"),
      false
    );
  });

  it("tenant_portal still sends reminder and active", () => {
    assert.equal(shouldNotifyTenantAccessEvent("tenant_portal", "ACCESS_TENANT_REMINDER"), true);
    assert.equal(shouldNotifyTenantAccessEvent("tenant_portal", "ACCESS_TENANT_ACTIVE"), true);
  });

  it("sms inbound channel sends confirmation", () => {
    assert.equal(shouldNotifyTenantAccessEvent("sms", "ACCESS_TENANT_RESERVATION_CONFIRMED"), true);
  });
});
