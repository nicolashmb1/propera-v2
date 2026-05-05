/**
 * Parity / golden cases for ported router precursors (GAS-aligned).
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { complianceIntent } = require("../src/brain/router/complianceIntent");
const { detectTenantCommand } = require("../src/brain/router/detectTenantCommand");
const { normMsg } = require("../src/brain/router/normMsg");
const { evaluateRouterPrecursor } = require("../src/brain/router/evaluateRouterPrecursor");

describe("normMsg (15_GATEWAY_WEBHOOK.gs)", () => {
  test("collapses space and uppercases", () => {
    assert.equal(normMsg("  hello   world  "), "HELLO WORLD");
  });
});

describe("complianceIntent (15_GATEWAY_WEBHOOK.gs)", () => {
  test("STOP class", () => {
    assert.equal(complianceIntent("STOP"), "STOP");
    assert.equal(complianceIntent("stop"), "STOP");
    assert.equal(complianceIntent("STOPALL"), "STOP");
  });
  test("START class", () => {
    assert.equal(complianceIntent("START"), "START");
  });
  test("HELP class", () => {
    assert.equal(complianceIntent("HELP"), "HELP");
    assert.equal(complianceIntent("help"), "HELP");
  });
  test("empty", () => {
    assert.equal(complianceIntent(""), "");
  });
});

describe("detectTenantCommand (16_ROUTER_ENGINE.gs)", () => {
  test("commands", () => {
    assert.equal(detectTenantCommand("my tickets"), "CMD_MY_TICKETS");
    assert.equal(detectTenantCommand("HELP"), "CMD_HELP");
    assert.equal(detectTenantCommand("random xyz"), null);
  });
  test("help", () => {
    assert.equal(detectTenantCommand("help"), "CMD_HELP");
  });
});

describe("evaluateRouterPrecursor ordering", () => {
  test("help → compliance HELP, tenant command suppressed", () => {
    const p = evaluateRouterPrecursor({
      parameter: { Body: "help", From: "TG:1", _channel: "TELEGRAM" },
    });
    assert.equal(p.compliance, "HELP");
    assert.equal(p.tenantCommand, null);
  });
  test("my tickets → no compliance, tenant command", () => {
    const p = evaluateRouterPrecursor({
      parameter: { Body: "my tickets", From: "TG:1" },
    });
    assert.equal(p.compliance, null);
    assert.equal(p.tenantCommand, "CMD_MY_TICKETS");
  });
  test("# prefix → staff capture", () => {
    const p = evaluateRouterPrecursor({
      parameter: { Body: "# capture test", From: "TG:1" },
    });
    assert.equal(p.outcome, "STAFF_CAPTURE_HASH");
    assert.equal(p.staffCapture.stripped, "capture test");
    assert.equal(p.staffCapture.mode, "MANAGER");
  });
  test("staff sender → lifecycle gate before compliance (GAS 300–312 before 382+)", () => {
    const p = evaluateRouterPrecursor({
      parameter: { Body: "help", From: "TG:99", _channel: "TELEGRAM" },
      staffContext: { isStaff: true, staffActorKey: "TG:99" },
    });
    assert.equal(p.outcome, "STAFF_LIFECYCLE_GATE");
    assert.equal(p.staffGate.staffActorKey, "TG:99");
    assert.equal(p.compliance, null);
    assert.equal(p.tenantCommand, null);
  });
  test("staff sender with empty body → lifecycle gate (never tenant PRECURSOR_EVALUATED)", () => {
    const p = evaluateRouterPrecursor({
      parameter: { Body: "", From: "TG:99", _channel: "TELEGRAM" },
      staffContext: { isStaff: true, staffActorKey: "TG:99" },
    });
    assert.equal(p.outcome, "STAFF_LIFECYCLE_GATE");
    assert.equal(p.compliance, null);
    assert.equal(p.tenantCommand, null);
  });
  test("non-staff help → compliance HELP unchanged", () => {
    const p = evaluateRouterPrecursor({
      parameter: { Body: "help", From: "TG:1" },
      staffContext: { isStaff: false, staffActorKey: "TG:1" },
    });
    assert.equal(p.outcome, "PRECURSOR_EVALUATED");
    assert.equal(p.compliance, "HELP");
  });
});
