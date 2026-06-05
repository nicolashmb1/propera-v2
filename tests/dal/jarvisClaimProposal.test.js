const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  tryClaimProposalForCommit,
} = require("../../src/dal/jarvisOperatorThreads");

/**
 * Minimal sb mock exposing only `.rpc` returning a canned jarvis_transition_proposal result.
 * @param {{ data?: object, error?: object } | (() => { data?: object, error?: object })} reply
 */
function rpcSb(reply, calls) {
  return {
    rpc(name, args) {
      if (calls) calls.push({ name, args });
      return Promise.resolve(typeof reply === "function" ? reply(args) : reply);
    },
  };
}

const threadRow = {
  thread_id: "t1",
  actor_key: "+15551230000",
  transport_channel: "portal",
  anchor_fingerprint: "global",
  status: "executing",
  pending_proposals: [{ proposal_id: "p1", op: "schedule_ticket", state: "executing" }],
  last_receipt: null,
};

describe("tryClaimProposalForCommit (atomic RPC path)", () => {
  it("maps applied=true to a claimed kind and threads the returned row", async () => {
    const calls = [];
    const sb = rpcSb(
      { data: { found: true, present: true, applied: true, current_state: "executing", thread: threadRow }, error: null },
      calls
    );
    const res = await tryClaimProposalForCommit(sb, { threadId: "t1", proposalId: "p1" });
    assert.equal(res.kind, "claimed");
    assert.equal(res.thread.threadId, "t1");
    // CAS args: only awaiting_confirm -> executing.
    assert.deepEqual(calls[0].args.p_from_states, ["awaiting_confirm"]);
    assert.equal(calls[0].args.p_to_state, "executing");
  });

  it("maps a lost CAS race (already committed) to already_committed", async () => {
    const sb = rpcSb({
      data: {
        found: true,
        present: true,
        applied: false,
        current_state: "committed",
        thread: { ...threadRow, status: "done", last_receipt: { reply_preview: "done" } },
      },
      error: null,
    });
    const res = await tryClaimProposalForCommit(sb, { threadId: "t1", proposalId: "p1" });
    assert.equal(res.kind, "already_committed");
  });

  it("maps a concurrent in-flight claim to in_flight", async () => {
    const sb = rpcSb({
      data: { found: true, present: true, applied: false, current_state: "executing", thread: threadRow },
      error: null,
    });
    const res = await tryClaimProposalForCommit(sb, { threadId: "t1", proposalId: "p1" });
    assert.equal(res.kind, "in_flight");
  });

  it("maps missing thread to not_found", async () => {
    const sb = rpcSb({ data: { found: false }, error: null });
    const res = await tryClaimProposalForCommit(sb, { threadId: "t1", proposalId: "p1" });
    assert.equal(res.kind, "not_found");
  });

  it("maps a proposal absent from the thread to not_awaiting", async () => {
    const sb = rpcSb({ data: { found: true, present: false, thread: threadRow }, error: null });
    const res = await tryClaimProposalForCommit(sb, { threadId: "t1", proposalId: "p1" });
    assert.equal(res.kind, "not_awaiting");
  });

  it("falls back to legacy claim when the RPC errors (migration not deployed)", async () => {
    // sb.rpc errors → code must fall back to read-modify-write via .from(...).
    const fallbackThread = {
      thread_id: "t1",
      actor_key: "+15551230000",
      transport_channel: "portal",
      anchor_fingerprint: "global",
      status: "proposal_pending",
      pending_proposals: [{ proposal_id: "p1", op: "schedule_ticket", state: "awaiting_confirm" }],
      last_receipt: null,
    };
    let upsertCount = 0;
    const sb = {
      rpc() {
        return Promise.resolve({ data: null, error: { code: "PGRST202", message: "not found" } });
      },
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({ data: fallbackThread, error: null });
          },
          upsert() {
            upsertCount += 1;
            return {
              select() {
                return {
                  maybeSingle() {
                    return Promise.resolve({
                      data: {
                        ...fallbackThread,
                        status: "executing",
                        pending_proposals: [
                          { proposal_id: "p1", op: "schedule_ticket", state: "executing" },
                        ],
                      },
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      },
    };
    const res = await tryClaimProposalForCommit(sb, { threadId: "t1", proposalId: "p1" });
    assert.equal(res.kind, "claimed");
    assert.ok(upsertCount >= 1, "legacy fallback should write via upsert");
  });

  it("falls back to legacy when sb has no rpc (older mock)", async () => {
    const sb = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
    const res = await tryClaimProposalForCommit(sb, { threadId: "t1", proposalId: "p1" });
    assert.equal(res.kind, "not_found");
  });
});
