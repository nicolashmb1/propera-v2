const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  parsePortalPmTicketBody,
  parsePortalPmTicketRequest,
  pickIssueFromPayload,
  pickTicketLookupHintFromFlat,
  normalizePortalTicketStatus,
  normalizePortalPriority,
} = require("../src/dal/portalTicketMutations");

describe("parsePortalPmTicketBody", () => {
  test("soft delete / cancel wire", () => {
    const p = parsePortalPmTicketBody("  penn-042626-1877 canceled  ");
    assert.deepEqual(p, { kind: "soft_delete", humanTicketId: "PENN-042626-1877" });
  });

  test("update with status Open", () => {
    const p = parsePortalPmTicketBody("Update PENN-042626-1877. status Open.");
    assert.equal(p && p.kind, "update");
    assert.equal(p.humanTicketId, "PENN-042626-1877");
    assert.equal(p.fields.statusRaw, "Open");
  });

  test("update with status and issue", () => {
    const p = parsePortalPmTicketBody(
      "Update MURR-010126-4000 status In Progress. issue: AC leak. category: HVAC."
    );
    assert.equal(p && p.kind, "update");
    assert.equal(p.humanTicketId, "MURR-010126-4000");
    assert.equal(p.fields.statusRaw, "In Progress");
    assert.equal(p.fields.issue, "AC leak");
    assert.equal(p.fields.category, "HVAC");
  });

  test("non-portal body falls through", () => {
    assert.equal(parsePortalPmTicketBody("done"), null);
    assert.equal(parsePortalPmTicketBody("# capture"), null);
  });

  test("update rest parses urgency / priority", () => {
    const p = parsePortalPmTicketBody(
      "Update PENN-042626-1877. urgency high. service notes: left key at office."
    );
    assert.equal(p && p.kind, "update");
    assert.equal(p.fields.urgency, "high");
    assert.equal(p.fields.serviceNotes, "left key at office.");
  });

  test("preferred window label", () => {
    const p = parsePortalPmTicketBody(
      "Update PENN-042626-1877. preferred window: tomorrow 9–12."
    );
    assert.equal(p && p.kind, "update");
    assert.equal(p.fields.preferredWindow, "tomorrow 9–12.");
  });

  test("issue keeps text after periods until next field", () => {
    const p = parsePortalPmTicketBody(
      "Update PENN-042626-1877. issue: Sink drips. Pool light flickers. category: Plumbing."
    );
    assert.equal(p && p.kind, "update");
    assert.equal(p.fields.issue, "Sink drips. Pool light flickers");
    assert.equal(p.fields.category, "Plumbing");
  });

  test("issue preserves trailing punctuation (dot comma)", () => {
    const p = parsePortalPmTicketBody(
      "Update PENN-042626-1877. issue: AC noisy, fan rattles."
    );
    assert.equal(p && p.kind, "update");
    assert.equal(p.fields.issue, "AC noisy, fan rattles.");
  });
});

describe("parsePortalPmTicketRequest (Body + _portalPayloadJson)", () => {
  test("JSON-only update when ticketId in payload", () => {
    const p = parsePortalPmTicketRequest({
      Body: "noop",
      _portalPayloadJson: JSON.stringify({
        ticketId: "PENN-042626-1877",
        category: "Plumbing",
        urgency: "urgent",
        issue: "Leak under sink",
      }),
    });
    assert.equal(p && p.kind, "update");
    assert.equal(p.humanTicketId, "PENN-042626-1877");
    assert.equal(p.fields.category, "Plumbing");
    assert.equal(p.fields.urgency, "urgent");
    assert.equal(p.fields.issue, "Leak under sink");
  });

  test("structured JSON wins over wire Update line for same field (portal save authority)", () => {
    const p = parsePortalPmTicketRequest({
      Body: "Update PENN-042626-1877. category Electrical.",
      _portalPayloadJson: JSON.stringify({
        ticketId: "PENN-042626-1877",
        category: "Plumbing",
      }),
    });
    assert.equal(p.fields.category, "Plumbing");
  });

  test("issueText in JSON when issue key absent", () => {
    const p = parsePortalPmTicketRequest({
      Body: "Update PENN-042626-1877. status Open.",
      _portalPayloadJson: JSON.stringify({
        ticketId: "PENN-042626-1877",
        issueText: "Full text from form.",
      }),
    });
    assert.equal(p.fields.issue, "Full text from form.");
    assert.equal(p.fields.statusRaw, "Open");
  });

  test("issue nested under ticket object in payload", () => {
    const p = parsePortalPmTicketRequest({
      Body: "noop",
      _portalPayloadJson: JSON.stringify({
        action: "staff_command",
        ticket: {
          ticketId: "PENN-042626-1877",
          issue: "Nested issue body.",
        },
      }),
    });
    assert.equal(p && p.kind, "update");
    assert.equal(p.humanTicketId, "PENN-042626-1877");
    assert.equal(p.fields.issue, "Nested issue body.");
  });

  test("full row save: uuid id + message_raw (propera-app shape)", () => {
    const row = {
      id: "3a96365b-5f86-4824-8265-91f0522c4b07",
      ticket_id: "PENN-042626-8784",
      message_raw: "ICEMAKER WORKS BUT DISPENSER IS NOT WORKING",
      status: "Open",
    };
    const p = parsePortalPmTicketRequest({
      Body: "noop",
      _portalPayloadJson: JSON.stringify({ action: "staff_command", ticket: row }),
    });
    assert.equal(p && p.kind, "update");
    assert.equal(p.humanTicketId, "PENN-042626-8784");
    assert.equal(
      p.fields.issue,
      "ICEMAKER WORKS BUT DISPENSER IS NOT WORKING"
    );
  });

  test("uuid id when ticket_id absent in payload", () => {
    const p = parsePortalPmTicketRequest({
      Body: "noop",
      _portalPayloadJson: JSON.stringify({
        id: "3a96365b-5f86-4824-8265-91f0522c4b07",
        message_raw: "Edited via uuid only",
      }),
    });
    assert.equal(p && p.kind, "update");
    assert.equal(p.humanTicketId, "3a96365b-5f86-4824-8265-91f0522c4b07");
    assert.equal(p.fields.issue, "Edited via uuid only");
  });

  test("PM form PATCH: issue text under fields{ message_raw } (meta-only siblings)", () => {
    const p = parsePortalPmTicketRequest({
      Body: "noop",
      _portalPayloadJson: JSON.stringify({
        action: "staff_command",
        fields: {
          ticket_id: "PENN-042626-8784",
          message_raw: "ICEMAKER WORKS BUT DISPENSER IS NOT WORKING",
          category: "Appliance",
          urgency: "Normal",
          status: "Open",
        },
      }),
    });
    assert.equal(p && p.kind, "update");
    assert.equal(p.humanTicketId, "PENN-042626-8784");
    assert.equal(
      p.fields.issue,
      "ICEMAKER WORKS BUT DISPENSER IS NOT WORKING"
    );
    assert.equal(p.fields.category, "Appliance");
  });

  test("ticket baseline message_raw survives partial updates{} (no undefined wipe)", () => {
    const p = parsePortalPmTicketRequest({
      Body: "noop",
      _portalPayloadJson: JSON.stringify({
        ticket: {
          ticket_id: "PENN-042626-8784",
          message_raw: "BASELINE ISSUE TEXT",
        },
        updates: {
          category: "Plumbing",
          urgency: "Normal",
          status: "Open",
        },
      }),
    });
    assert.equal(p?.fields.issue, "BASELINE ISSUE TEXT");
    assert.equal(p?.fields.category, "Plumbing");
  });

  test("freeform Body = edited issue when JSON has ticketId + meta only (PM app shape)", () => {
    const p = parsePortalPmTicketRequest({
      Body: "ICEMAKER WORKS BUT DISPENSER IS NOT WORKING",
      _portalPayloadJson: JSON.stringify({
        ticketId: "PENN-042626-8784",
        status: "Open",
        category: "Appliance",
        urgency: "Normal",
      }),
    });
    assert.equal(p?.kind, "update");
    assert.equal(p?.humanTicketId, "PENN-042626-8784");
    assert.equal(p?.fields.issue, "ICEMAKER WORKS BUT DISPENSER IS NOT WORKING");
    assert.equal(p?.fields.category, "Appliance");
  });

  test("noop Body does not override JSON message_raw", () => {
    const p = parsePortalPmTicketRequest({
      Body: "noop",
      _portalPayloadJson: JSON.stringify({
        ticket_id: "PENN-042626-8784",
        message_raw: "FROM JSON ONLY",
        category: "Appliance",
      }),
    });
    assert.equal(p?.fields.issue, "FROM JSON ONLY");
  });
});

describe("pickIssueFromPayload", () => {
  test("prefers first non-empty in key order", () => {
    assert.equal(
      pickIssueFromPayload({ issue: "", issueText: "from text field" }),
      "from text field"
    );
    assert.equal(pickIssueFromPayload({ summary: "S" }), "S");
  });

  test("message_raw wins over issue when both set (row-shaped PATCH)", () => {
    assert.equal(
      pickIssueFromPayload({
        issue: "stale",
        message_raw: "ICEMAKER WORKS BUT DISPENSER IS NOT WORKING",
      }),
      "ICEMAKER WORKS BUT DISPENSER IS NOT WORKING"
    );
  });
});

describe("pickTicketLookupHintFromFlat", () => {
  test("prefers human ticket_id over uuid id", () => {
    assert.equal(
      pickTicketLookupHintFromFlat({
        id: "3a96365b-5f86-4824-8265-91f0522c4b07",
        ticket_id: "PENN-042626-8784",
      }),
      "PENN-042626-8784"
    );
  });
});

describe("normalizePortalTicketStatus", () => {
  test("aliases", () => {
    assert.equal(normalizePortalTicketStatus("OPEN"), "Open");
    assert.equal(normalizePortalTicketStatus("done"), "Completed");
    assert.equal(normalizePortalTicketStatus("cancelled"), "Deleted");
  });
});

describe("normalizePortalPriority", () => {
  test("maps to tickets.priority vocabulary", () => {
    assert.equal(normalizePortalPriority("URGENT"), "urgent");
    assert.equal(normalizePortalPriority("high"), "high");
    assert.equal(normalizePortalPriority(""), "normal");
    assert.equal(normalizePortalPriority("medium"), "normal");
  });
});
