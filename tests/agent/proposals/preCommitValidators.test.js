const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { runPreCommitValidate } = require("../../../src/agent/proposals/preCommitValidators");
const { PROPOSAL_OPS } = require("../../../src/agent/proposals/types");

/** sb mock whose communication_campaigns lookup returns `row`. */
function campaignSb(row) {
  return {
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: row, error: null });
        },
      };
    },
  };
}

describe("runPreCommitValidate", () => {
  it("passes through ops with no registered validator", async () => {
    const res = await runPreCommitValidate(null, { op: PROPOSAL_OPS.SCHEDULE_TICKET }, {});
    assert.equal(res.ok, true);
  });

  it("send_communication_campaign: missing campaign id is stale", async () => {
    const res = await runPreCommitValidate(
      campaignSb({ id: "c1" }),
      { op: PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN, proposal_id: "p1", payload: {} },
      {}
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "stale_proposal");
    assert.equal(res.markState, "expired");
  });

  it("send_communication_campaign: deleted campaign row is stale with resolution", async () => {
    const res = await runPreCommitValidate(
      campaignSb(null),
      {
        op: PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN,
        proposal_id: "p1",
        payload: { campaign_id: "c-gone" },
      },
      {}
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "stale_proposal");
    assert.deepEqual(res.resolution, { error: "not_found", campaign_id: "c-gone" });
  });

  it("send_communication_campaign: existing campaign passes", async () => {
    const res = await runPreCommitValidate(
      campaignSb({ id: "c-live" }),
      {
        op: PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN,
        proposal_id: "p1",
        payload: { campaign_id: "c-live" },
      },
      {}
    );
    assert.equal(res.ok, true);
  });
});
