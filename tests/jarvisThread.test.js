const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAnchorFingerprint,
  buildThreadId,
  mergeAnchorHints,
} = require("../src/agent/thread/anchorFingerprint");
const {
  pruneExpiredPending,
  findAwaitingProposalForActor,
} = require("../src/dal/jarvisOperatorThreads");

test("buildAnchorFingerprint stable for same anchor", () => {
  const a = { propertyCode: "PENN", unit: "423", ticketRowId: "uuid-1" };
  assert.equal(buildAnchorFingerprint(a), buildAnchorFingerprint(a));
});

test("buildAnchorFingerprint differs for different units", () => {
  const a = { propertyCode: "PENN", unit: "423" };
  const b = { propertyCode: "PENN", unit: "424" };
  assert.notEqual(buildAnchorFingerprint(a), buildAnchorFingerprint(b));
});

test("buildAnchorFingerprint global when empty", () => {
  assert.equal(buildAnchorFingerprint({}), "global");
});

test("buildThreadId stable per actor channel anchor", () => {
  const fp = buildAnchorFingerprint({ propertyCode: "PENN", unit: "423" });
  const t1 = buildThreadId("+15551234567", "portal", fp);
  const t2 = buildThreadId("+15551234567", "portal", fp);
  assert.equal(t1, t2);
  assert.notEqual(t1, buildThreadId("+15559999999", "portal", fp));
});

test("mergeAnchorHints prefers page over cost", () => {
  const merged = mergeAnchorHints(
    { propertyCode: "PENN", unit: "423", humanTicketId: "PENN-1" },
    { propertyCode: "MORRIS", unit: "101" }
  );
  assert.equal(merged.propertyCode, "PENN");
  assert.equal(merged.unit, "423");
});

test("pruneExpiredPending marks expired awaiting_confirm", () => {
  const past = new Date(Date.now() - 60000).toISOString();
  const out = pruneExpiredPending([
    {
      proposal_id: "p1",
      state: "awaiting_confirm",
      expires_at: past,
    },
  ]);
  assert.equal(out[0].state, "expired");
});

test("findAwaitingProposalForActor picks latest awaiting with token", async () => {
  const fakeSb = {
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        order() {
          return this;
        },
        limit() {
          return Promise.resolve({
            data: [
              {
                thread_id: "t1",
                updated_at: new Date().toISOString(),
                pending_proposals: [
                  {
                    proposal_id: "p1",
                    state: "awaiting_confirm",
                    confirm_token: "tok-1",
                    created_at: new Date().toISOString(),
                  },
                ],
              },
            ],
            error: null,
          });
        },
      };
    },
  };
  const hit = await findAwaitingProposalForActor(fakeSb, "+15551234567", "portal");
  assert.equal(hit.threadId, "t1");
  assert.equal(hit.proposal.proposal_id, "p1");
});
