"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseVendorReply } = require("../../src/vendor/parseVendorReply");

test("parseVendorReply — empty and help", () => {
  assert.deepEqual(parseVendorReply(""), { kind: "empty" });
  assert.deepEqual(parseVendorReply("maybe later"), { kind: "help" });
});

test("parseVendorReply — accept with ticket id and window", () => {
  const p = parseVendorReply("YES PENN-012626-0001 tomorrow 9-11am");
  assert.equal(p.kind, "accept");
  assert.equal(p.explicitTicketId, "PENN-012626-0001");
  assert.equal(p.tail, "tomorrow 9-11am");
});

test("parseVendorReply — decline shorthand", () => {
  const p = parseVendorReply("N");
  assert.equal(p.kind, "decline");
  assert.equal(p.explicitTicketId, "");
});

test("parseVendorReply — accept without ticket id", () => {
  const p = parseVendorReply("Y Mon 2-4pm");
  assert.equal(p.kind, "accept");
  assert.equal(p.explicitTicketId, "");
  assert.equal(p.tail, "Mon 2-4pm");
});
