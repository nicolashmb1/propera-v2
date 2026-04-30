const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseStaffCapDraftIdFromStripped,
  tagStaffCaptureReply,
} = require("../src/dal/staffCaptureDraft");

test("parseStaffCapDraftIdFromStripped — new capture (no d prefix)", () => {
  const r = parseStaffCapDraftIdFromStripped("apt 304 penn kitchen clogged");
  assert.equal(r.draftSeq, null);
  assert.match(r.rest, /apt 304 penn/i);
});

test("parseStaffCapDraftIdFromStripped — continuation #d26 penn", () => {
  const r = parseStaffCapDraftIdFromStripped("d26 penn");
  assert.equal(r.draftSeq, 26);
  assert.equal(r.rest, "penn");
});

test("tagStaffCaptureReply", () => {
  assert.equal(
    tagStaffCaptureReply(12, "Missing property"),
    "D12: Missing property"
  );
});
