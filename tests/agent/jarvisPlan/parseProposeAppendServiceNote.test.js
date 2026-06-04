const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseProposeAppendServiceNote } = require("../../../src/agent/jarvisPlan/parseProposeAppendServiceNote");

describe("parseProposeAppendServiceNote", () => {
  it("parses note: prefix", () => {
    const p = parseProposeAppendServiceNote("note: need to order heat exchanger", {});
    assert.ok(p);
    assert.equal(p.noteText, "need to order heat exchanger");
  });

  it("parses service note with ticket id", () => {
    const p = parseProposeAppendServiceNote(
      "note: MURR-053026-4247 parts ordered",
      {}
    );
    assert.ok(p);
    assert.equal(p.humanTicketId, "MURR-053026-4247");
    assert.match(p.noteText, /parts ordered/i);
  });

  it("ignores cost messages", () => {
    assert.equal(parseProposeAppendServiceNote("$$42 homedepot", {}), null);
  });
});
