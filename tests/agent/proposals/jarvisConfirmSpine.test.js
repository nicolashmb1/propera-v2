const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { formatJarvisConfirmReceipt } = require("../../../src/agent/proposals/jarvisConfirmReceipt");
const { buildAppendServiceNoteProposal } = require("../../../src/agent/proposals/appendServiceNote");
const { buildProposalConfirmToken, verifyProposalConfirmToken } = require("../../../src/agent/proposals/proposalToken");
const { PROPOSAL_OPS } = require("../../../src/agent/proposals/types");
const {
  findRecentDuplicateSchedule,
  findRecentDuplicateAppendNote,
  idempotentConfirmFromThread,
} = require("../../../src/dal/jarvisOperatorThreads");

describe("jarvis confirm spine helpers", () => {
  it("formatJarvisConfirmReceipt uses ticket-specific copy for notes", () => {
    const receipt = formatJarvisConfirmReceipt(
      { op: PROPOSAL_OPS.APPEND_SERVICE_NOTE, payload: { human_ticket_id: "PENN-060126-0001" } },
      { replyText: "Added service note to PENN-060126-0001." }
    );
    assert.equal(receipt, "Note added to PENN-060126-0001.");
  });

  it("findRecentDuplicateSchedule matches ticket + window", () => {
    const thread = {
      lastReceipt: {
        committed_op: "schedule_ticket",
        human_ticket_id: "PENN-060126-0042",
        preferred_window: "today 1-5pm",
        at: new Date().toISOString(),
      },
    };
    const hit = findRecentDuplicateSchedule(thread, {
      humanTicketId: "PENN-060126-0042",
      preferredWindow: "today 1-5pm",
    });
    assert.ok(hit);
    assert.equal(
      findRecentDuplicateSchedule(thread, {
        humanTicketId: "PENN-060126-0042",
        preferredWindow: "tomorrow morning",
      }),
      null
    );
  });

  it("findRecentDuplicateAppendNote matches same note text", () => {
    const thread = {
      lastReceipt: {
        committed_op: "append_service_note",
        human_ticket_id: "PENN-060126-0099",
        note_text: "ordered replacement gasket",
        at: new Date().toISOString(),
      },
    };
    assert.ok(
      findRecentDuplicateAppendNote(thread, {
        humanTicketId: "PENN-060126-0099",
        noteText: "ordered replacement gasket",
      })
    );
    assert.equal(
      findRecentDuplicateAppendNote(thread, {
        humanTicketId: "PENN-060126-0099",
        noteText: "different note",
      }),
      null
    );
  });

  it("idempotentConfirmFromThread prefers last receipt preview", () => {
    const out = idempotentConfirmFromThread(
      {
        lastReceipt: {
          reply_preview: "Scheduled PENN-060126-0042: today 1-5pm.",
          human_ticket_id: "PENN-060126-0042",
        },
      },
      { op: "schedule_ticket", proposal_id: "abc" }
    );
    assert.equal(out.reply, "Scheduled PENN-060126-0042: today 1-5pm.");
    assert.equal(out.human_ticket_id, "PENN-060126-0042");
  });

  it("confirm token round-trips for shared spine ops", () => {
    const { confirmToken } = buildAppendServiceNoteProposal(
      {
        humanTicketId: "PENN-060126-0001",
        noteText: "needs part",
      },
      "Append note"
    );
    const verified = verifyProposalConfirmToken(confirmToken);
    assert.equal(verified.op, PROPOSAL_OPS.APPEND_SERVICE_NOTE);
    assert.equal(verified.payload.noteText || verified.payload.note_text, "needs part");
  });
});
