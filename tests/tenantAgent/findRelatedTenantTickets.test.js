"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  scoreTicketAgainstHints,
  classifyScoredMatches,
} = require("../../src/dal/findRelatedTenantTickets");

test("scoreTicketAgainstHints — sink leak matches plumbing ticket", () => {
  const score = scoreTicketAgainstHints(
    {
      message_raw: "Kitchen sink is leaking",
      category: "Plumbing",
      unit_label: "410",
      property_code: "PENN",
    },
    {
      issueText: "my sink is still leaking",
      unitHint: "410",
      property_code: "PENN",
      categoryHint: "Plumbing",
    }
  );
  assert.ok(score >= 4);
});

test("classifyScoredMatches — single strong when one clear winner", () => {
  const r = classifyScoredMatches([
    { ticket_key: "a", ticket_id: "PENN-1", score: 10, issueSnippet: "sink" },
    { ticket_key: "b", ticket_id: "PENN-2", score: 2, issueSnippet: "door" },
  ]);
  assert.equal(r.matchStatus, "single_strong_match");
  assert.equal(r.ticket.ticket_key, "a");
});

test("classifyScoredMatches — no match when scores low", () => {
  const r = classifyScoredMatches([
    { ticket_key: "a", ticket_id: "PENN-1", score: 1, issueSnippet: "x" },
  ]);
  assert.equal(r.matchStatus, "no_match");
});
