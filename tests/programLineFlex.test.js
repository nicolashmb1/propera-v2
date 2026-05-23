const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateProgramLineReorder,
  PROGRAM_LINE_SCOPE_TYPES,
} = require("../src/dal/programRuns");
const { PROGRAM_TIMELINE_KINDS, isProgramTimelineKind } = require("../src/dal/programTimeline");

test("validateProgramLineReorder accepts full permutation", () => {
  const ids = ["a", "b", "c"];
  assert.equal(validateProgramLineReorder(["c", "a", "b"], ids).ok, true);
});

test("validateProgramLineReorder rejects unknown id", () => {
  const r = validateProgramLineReorder(["a", "x"], ["a", "b"]);
  assert.equal(r.ok, false);
  assert.equal(r.error, "reorder_unknown_line");
});

test("validateProgramLineReorder rejects count mismatch", () => {
  const r = validateProgramLineReorder(["a"], ["a", "b"]);
  assert.equal(r.ok, false);
  assert.equal(r.error, "reorder_count_mismatch");
});

test("PROGRAM_LINE_SCOPE_TYPES includes SITE", () => {
  assert.ok(PROGRAM_LINE_SCOPE_TYPES.has("SITE"));
  assert.ok(PROGRAM_LINE_SCOPE_TYPES.has("CUSTOM") === false);
});

test("program timeline kinds contract", () => {
  assert.ok(PROGRAM_TIMELINE_KINDS.includes("line_added"));
  assert.ok(PROGRAM_TIMELINE_KINDS.includes("ticket_linked"));
  assert.ok(isProgramTimelineKind("run_created"));
  assert.equal(isProgramTimelineKind("bogus"), false);
});
