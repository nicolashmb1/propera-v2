/**
 * Tests for the typed maintenance slots in conversationState.js.
 *
 * Companion to conversationState.test.js (access slots). The two slots
 * exercised here are:
 *   - _maintenance_last_ticket  (recorded after a successful handoff)
 *   - _maintenance_last_error   (recorded after a handoff-contract rejection)
 *
 * In-flight maintenance gather fields (property/unit/issue/...) still live
 * flat on partial_package — see the file header in conversationState.js for
 * why migrating them is out of scope.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  MAINTENANCE_FIELD,
  normalizePartialPackage,
  readMaintenanceLastTicket,
  withMaintenanceLastTicket,
  withoutMaintenanceLastTicket,
  readMaintenanceLastError,
  withMaintenanceLastError,
  withoutMaintenanceLastError,
  recordMaintenanceTicketSuccess,
  recordMaintenanceContractRejection,
  clearMaintenanceLane,
  withActiveLane,
  readActiveLane,
  CONVERSATION_LANE,
} = require("../../src/adapters/tenantAgent/conversationState");

describe("conversationState — maintenance slot keys", () => {
  it("exposes the canonical underscore-prefixed keys", () => {
    assert.equal(MAINTENANCE_FIELD.MAINTENANCE_LAST_TICKET, "_maintenance_last_ticket");
    assert.equal(MAINTENANCE_FIELD.MAINTENANCE_LAST_ERROR, "_maintenance_last_error");
  });

  it("MAINTENANCE_FIELD is frozen — extra keys silently refused", () => {
    // Object.freeze silently no-ops in non-strict mode; we assert by checking
    // the key set didn't change rather than expecting a throw.
    const keysBefore = Object.keys(MAINTENANCE_FIELD).sort();
    try {
      MAINTENANCE_FIELD.NEW_THING = "x";
    } catch (_) {
      // strict-mode env may throw — also acceptable.
    }
    const keysAfter = Object.keys(MAINTENANCE_FIELD).sort();
    assert.deepEqual(keysAfter, keysBefore);
    assert.equal(MAINTENANCE_FIELD.NEW_THING, undefined);
  });
});

describe("conversationState — normalize maintenance slots", () => {
  it("drops a non-object _maintenance_last_ticket", () => {
    const out = normalizePartialPackage({ _maintenance_last_ticket: "bogus" });
    assert.equal(out._maintenance_last_ticket, undefined);
  });

  it("drops an array _maintenance_last_ticket (typeof === 'object' tripwire)", () => {
    const out = normalizePartialPackage({ _maintenance_last_ticket: ["nope"] });
    assert.equal(out._maintenance_last_ticket, undefined);
  });

  it("preserves a well-shaped _maintenance_last_ticket", () => {
    const slot = { ticketKey: "PROP-1", at: "2026-05-27T10:00:00.000Z" };
    const out = normalizePartialPackage({ _maintenance_last_ticket: slot });
    assert.deepEqual(out._maintenance_last_ticket, slot);
  });

  it("drops a non-object _maintenance_last_error", () => {
    const out = normalizePartialPackage({ _maintenance_last_error: 42 });
    assert.equal(out._maintenance_last_error, undefined);
  });

  it("preserves a well-shaped _maintenance_last_error", () => {
    const slot = { stage: "handoff_contract", rejectedFields: ["issue"] };
    const out = normalizePartialPackage({ _maintenance_last_error: slot });
    assert.deepEqual(out._maintenance_last_error, slot);
  });
});

describe("conversationState — withMaintenanceLastTicket", () => {
  it("writes a typed slot with sensible coercions", () => {
    const out = withMaintenanceLastTicket(
      {},
      {
        ticketKey: " PROP-7 ",
        propertyCode: "penn",
        unitLabel: "502",
        locationKind: "UNIT",
        category: "Plumbing",
        issueSummary: "leak under sink",
        preferredWindow: "tomorrow afternoon",
        emergency: false,
        at: "2026-05-27T18:00:00.000Z",
      }
    );
    assert.deepEqual(out._maintenance_last_ticket, {
      ticketKey: "PROP-7",
      propertyCode: "PENN",
      unitLabel: "502",
      locationKind: "unit",
      category: "Plumbing",
      issueSummary: "leak under sink",
      preferredWindow: "tomorrow afternoon",
      emergency: false,
      at: "2026-05-27T18:00:00.000Z",
    });
  });

  it("truncates a long issueSummary to ~120 chars", () => {
    const longIssue = "x".repeat(500);
    const out = withMaintenanceLastTicket({}, { ticketKey: "P-1", issueSummary: longIssue });
    const summary = out._maintenance_last_ticket.issueSummary;
    assert.ok(summary.length <= 120, `issueSummary truncated to ${summary.length} chars`);
  });

  it("collapses internal whitespace in issueSummary", () => {
    const out = withMaintenanceLastTicket(
      {},
      { ticketKey: "P-1", issueSummary: "leak\n  under   sink  " }
    );
    assert.equal(out._maintenance_last_ticket.issueSummary, "leak under sink");
  });

  it("stamps `at` automatically when omitted", () => {
    const before = Date.now();
    const out = withMaintenanceLastTicket({}, { ticketKey: "P-1" });
    const at = new Date(out._maintenance_last_ticket.at).getTime();
    assert.ok(at >= before - 5, "at is recent");
  });

  it("withMaintenanceLastTicket(partial, null) drops the slot", () => {
    const out = withMaintenanceLastTicket({ _maintenance_last_ticket: { ticketKey: "P-1" } }, null);
    assert.equal(out._maintenance_last_ticket, undefined);
  });

  it("does not mutate the input partial", () => {
    const input = { issue: "leak" };
    withMaintenanceLastTicket(input, { ticketKey: "P-1" });
    assert.equal(input._maintenance_last_ticket, undefined);
  });
});

describe("conversationState — withMaintenanceLastError", () => {
  it("writes a typed slot, normalizing arrays + strings", () => {
    const out = withMaintenanceLastError(
      {},
      {
        stage: " handoff_contract ",
        rejectedFields: ["issue", "", null, "property"],
        rejectionReasons: ["too short", ""],
        replyText: " What's the issue? ",
        at: "2026-05-27T18:00:00.000Z",
      }
    );
    assert.deepEqual(out._maintenance_last_error, {
      stage: "handoff_contract",
      rejectedFields: ["issue", "property"],
      rejectionReasons: ["too short"],
      code: "",
      replyText: "What's the issue?",
      at: "2026-05-27T18:00:00.000Z",
    });
  });

  it("withMaintenanceLastError(partial, null) drops the slot", () => {
    const out = withMaintenanceLastError({ _maintenance_last_error: { stage: "x" } }, null);
    assert.equal(out._maintenance_last_error, undefined);
  });

  it("does not mutate the input partial", () => {
    const input = { issue: "leak" };
    withMaintenanceLastError(input, { stage: "handoff_contract" });
    assert.equal(input._maintenance_last_error, undefined);
  });
});

describe("conversationState — read helpers", () => {
  it("readMaintenanceLastTicket returns null when missing", () => {
    assert.equal(readMaintenanceLastTicket(null), null);
    assert.equal(readMaintenanceLastTicket({}), null);
  });

  it("readMaintenanceLastTicket returns null when slot is corrupted", () => {
    assert.equal(readMaintenanceLastTicket({ _maintenance_last_ticket: "bogus" }), null);
    assert.equal(readMaintenanceLastTicket({ _maintenance_last_ticket: ["bogus"] }), null);
  });

  it("readMaintenanceLastError returns null when missing or corrupted", () => {
    assert.equal(readMaintenanceLastError({}), null);
    assert.equal(readMaintenanceLastError({ _maintenance_last_error: 42 }), null);
  });
});

describe("conversationState — atomic transitions", () => {
  it("recordMaintenanceTicketSuccess stamps the ticket and clears any prior error", () => {
    const prev = {
      _maintenance_last_error: { stage: "handoff_contract", rejectedFields: ["issue"] },
      issue: "leak under sink",
    };
    const out = recordMaintenanceTicketSuccess(prev, {
      ticketKey: "PROP-7",
      propertyCode: "PENN",
      unitLabel: "502",
      issueSummary: "leak under sink",
    });
    assert.equal(out._maintenance_last_ticket.ticketKey, "PROP-7");
    assert.equal(out._maintenance_last_error, undefined);
    // Flat in-flight gather fields are intentionally preserved (see file header).
    assert.equal(out.issue, "leak under sink");
  });

  it("recordMaintenanceContractRejection stamps the error and defaults the stage", () => {
    const out = recordMaintenanceContractRejection(
      { issue: "x" },
      {
        rejectedFields: ["issue"],
        rejectionReasons: ["issue too short (1 chars, min 4)"],
        replyText: "What maintenance issue do you need help with?",
      }
    );
    assert.equal(out._maintenance_last_error.stage, "handoff_contract");
    assert.deepEqual(out._maintenance_last_error.rejectedFields, ["issue"]);
    assert.match(
      out._maintenance_last_error.rejectionReasons[0],
      /issue too short/
    );
    assert.equal(out.issue, "x");
  });

  it("recordMaintenanceContractRejection allows the caller to override stage", () => {
    const out = recordMaintenanceContractRejection({}, {
      stage: "core_brain",
      code: "validation_failed",
    });
    assert.equal(out._maintenance_last_error.stage, "core_brain");
    assert.equal(out._maintenance_last_error.code, "validation_failed");
  });

  it("clearMaintenanceLane strips lane + last error but KEEPS last_ticket", () => {
    let p = withActiveLane({}, CONVERSATION_LANE.MAINTENANCE);
    p = withMaintenanceLastTicket(p, { ticketKey: "PROP-7" });
    p = withMaintenanceLastError(p, { stage: "handoff_contract" });
    const out = clearMaintenanceLane(p);
    assert.equal(readActiveLane(out), "");
    assert.equal(out._maintenance_last_error, undefined);
    assert.equal(out._maintenance_last_ticket.ticketKey, "PROP-7");
  });
});

describe("conversationState — without helpers", () => {
  it("withoutMaintenanceLastTicket removes the slot", () => {
    const out = withoutMaintenanceLastTicket({ _maintenance_last_ticket: { ticketKey: "P-1" } });
    assert.equal(out._maintenance_last_ticket, undefined);
  });

  it("withoutMaintenanceLastError removes the slot", () => {
    const out = withoutMaintenanceLastError({ _maintenance_last_error: { stage: "x" } });
    assert.equal(out._maintenance_last_error, undefined);
  });
});
