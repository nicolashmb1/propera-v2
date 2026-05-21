"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

describe("tenantJwt", () => {
  const prev = process.env.TENANT_JWT_SECRET;

  before(() => {
    process.env.TENANT_JWT_SECRET = "test-secret-tenant-jwt-min-32-chars!!";
    process.env.TENANT_SESSION_DAYS = "1";
  });

  after(() => {
    if (prev === undefined) delete process.env.TENANT_JWT_SECRET;
    else process.env.TENANT_JWT_SECRET = prev;
  });

  it("signs and verifies tenant payload", () => {
    const { signTenantToken, verifyTenantToken } = require("../src/tenant/tenantJwt");
    const token = signTenantToken({
      tenantId: "11111111-1111-1111-1111-111111111111",
      unitId: "22222222-2222-2222-2222-222222222222",
      propertyCode: "PENN",
      unitLabel: "14B",
      orgId: "grand",
      phone: "+12015551234",
    });
    const ctx = verifyTenantToken(token);
    assert.equal(ctx.tenantId, "11111111-1111-1111-1111-111111111111");
    assert.equal(ctx.propertyCode, "PENN");
    assert.equal(ctx.unitLabel, "14B");
    assert.equal(ctx.orgId, "grand");
  });
});

describe("buildOtpMessage", () => {
  it("appends Propera attribution when enabled", () => {
    const { buildOtpMessage } = require("../src/tenant/tenantBrandResolve");
    const msg = buildOtpMessage("123456", {
      orgBrandShort: "The Grand",
      showProperaAttribution: true,
    });
    assert.match(msg, /The Grand/);
    assert.match(msg, /Powered by Propera/);
  });

  it("omits attribution when disabled", () => {
    const { buildOtpMessage } = require("../src/tenant/tenantBrandResolve");
    const msg = buildOtpMessage("123456", {
      orgBrandShort: "The Grand",
      showProperaAttribution: false,
    });
    assert.ok(!msg.includes("Propera"));
  });
});

describe("tenantDevOtpBypass", () => {
  it("is off in production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.TENANT_DEV_OTP_BYPASS = "1";
    delete require.cache[require.resolve("../src/config/env")];
    const { tenantDevOtpBypass } = require("../src/config/env");
    assert.equal(tenantDevOtpBypass(), false);
    process.env.NODE_ENV = prev;
    delete require.cache[require.resolve("../src/config/env")];
  });
});
