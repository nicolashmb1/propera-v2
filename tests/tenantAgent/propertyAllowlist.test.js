"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isPropertyOnTenantAgentPilot } = require("../../src/adapters/tenantAgent/propertyAllowlist");

test("propertyAllowlist — empty env allows all", () => {
  const prev = process.env.TENANT_AGENT_PROPERTY_ALLOWLIST;
  process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = "";
  assert.equal(isPropertyOnTenantAgentPilot("PENN"), true);
  assert.equal(isPropertyOnTenantAgentPilot(""), true);
  process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = prev;
});

test("propertyAllowlist — pilot codes only", () => {
  const prev = process.env.TENANT_AGENT_PROPERTY_ALLOWLIST;
  process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = "penn, demo";
  assert.equal(isPropertyOnTenantAgentPilot("PENN"), true);
  assert.equal(isPropertyOnTenantAgentPilot("OTHER"), false);
  process.env.TENANT_AGENT_PROPERTY_ALLOWLIST = prev;
});
