const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  findRecentCommittedOp,
  findRecentDuplicateCreate,
  findProposalStateOnThread,
} = require("../../src/dal/jarvisOperatorThreads");

describe("jarvisOperatorThreads dedupe helpers", () => {
  it("findRecentCommittedOp matches op, target, and recency", () => {
    const thread = {
      lastReceipt: {
        committed_op: "create_service_request",
        human_ticket_id: "PENN-060226-8763",
        reply_preview: "Created PENN-060226-8763 for unit 502 at PENN.",
        at: new Date().toISOString(),
      },
      scopeSnapshot: {
        anchor: { propertyCode: "PENN", unit: "502" },
      },
    };
    const hit = findRecentCommittedOp(thread, "create_service_request", {
      propertyCode: "PENN",
      unitLabel: "502",
    });
    assert.equal(hit.human_ticket_id, "PENN-060226-8763");
  });

  it("findRecentCommittedOp rejects stale or mismatched target", () => {
    const thread = {
      lastReceipt: {
        committed_op: "create_service_request",
        at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
      scopeSnapshot: { anchor: { propertyCode: "PENN", unit: "502" } },
    };
    assert.equal(
      findRecentCommittedOp(thread, "create_service_request", {
        propertyCode: "PENN",
        unitLabel: "502",
      }),
      null
    );
    assert.equal(
      findRecentCommittedOp(
        {
          ...thread,
          lastReceipt: { ...thread.lastReceipt, at: new Date().toISOString() },
        },
        "create_service_request",
        { propertyCode: "PENN", unitLabel: "303" }
      ),
      null
    );
  });

  it("findRecentDuplicateCreate blocks same issue only", () => {
    const thread = {
      lastReceipt: {
        committed_op: "create_service_request",
        human_ticket_id: "PENN-060226-8763",
        property_code: "PENN",
        unit_label: "505",
        issue_text: "refrigerator not working",
        preferred_window: "after 3pm",
        at: new Date().toISOString(),
      },
      scopeSnapshot: {
        anchor: { propertyCode: "PENN", unit: "505" },
      },
    };

    const sameIssue = findRecentDuplicateCreate(thread, {
      propertyCode: "PENN",
      unitLabel: "505",
      issueText: "refrigerator is not working",
    });
    assert.equal(sameIssue.human_ticket_id, "PENN-060226-8763");

    const differentIssue = findRecentDuplicateCreate(thread, {
      propertyCode: "PENN",
      unitLabel: "505",
      issueText: "AC machine not working",
    });
    assert.equal(differentIssue, null);
  });

  it("findProposalStateOnThread returns committed state", () => {
    const thread = {
      pendingProposals: [
        { proposal_id: "abc", state: "committed" },
        { proposal_id: "def", state: "awaiting_confirm" },
      ],
    };
    assert.equal(findProposalStateOnThread(thread, "abc"), "committed");
    assert.equal(findProposalStateOnThread(thread, "def"), "awaiting_confirm");
    assert.equal(findProposalStateOnThread(thread, "missing"), null);
  });
});
