const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeCanEnterAccess } = require("../src/inbound/routeInboundDecision");

describe("computeCanEnterAccess", () => {
  const base = {
    laneDecision: { lane: "tenantLane" },
    dbConfigured: true,
    staffRun: null,
    complianceRun: null,
    suppressedRun: null,
    effectiveCompliance: null,
    precursor: { outcome: "PRECURSOR_EVALUATED", tenantCommand: null },
    transportChannel: "sms",
    staffContext: { isStaff: false },
  };

  it("allows tenant messaging transport", () => {
    assert.equal(computeCanEnterAccess(base), true);
  });

  it("rejects portal transport", () => {
    assert.equal(
      computeCanEnterAccess({
        ...base,
        transportChannel: "portal",
      }),
      false
    );
  });

  it("rejects staff lane", () => {
    assert.equal(
      computeCanEnterAccess({
        ...base,
        staffContext: { isStaff: true },
      }),
      false
    );
  });
});
