const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mergeMaintenanceDraftTurn,
  resolvePropertyFromReply,
} = require("../src/brain/core/mergeMaintenanceDraft");

const known = new Set(["PENN", "MORRIS"]);
const props = [
  { code: "PENN", display_name: "The Grand at Penn" },
  { code: "MORRIS", display_name: "The Grand at Morris" },
];

test("resolvePropertyFromReply — number index", () => {
  assert.equal(resolvePropertyFromReply("2", props), "MORRIS");
});

test("resolvePropertyFromReply — code token", () => {
  assert.equal(resolvePropertyFromReply("MORRIS", props), "MORRIS");
});

test("merge ISSUE stage fills issue from body", () => {
  const m = mergeMaintenanceDraftTurn({
    bodyText: "icemaker not working",
    expected: "ISSUE",
    draft_issue: "",
    draft_property: "",
    draft_unit: "",
    draft_schedule_raw: "",
    knownPropertyCodesUpper: known,
    propertiesList: props,
  });
  assert.ok(m.draft_issue.toLowerCase().includes("icemaker"));
});

test("merge PROPERTY stage sets code", () => {
  const m = mergeMaintenanceDraftTurn({
    bodyText: "Morris",
    expected: "PROPERTY",
    draft_issue: "icemaker",
    draft_property: "",
    draft_unit: "",
    draft_schedule_raw: "",
    knownPropertyCodesUpper: known,
    propertiesList: props,
  });
  assert.equal(m.draft_property, "MORRIS");
});

test("merge UNIT stage", () => {
  const m = mergeMaintenanceDraftTurn({
    bodyText: "401",
    expected: "UNIT",
    draft_issue: "icemaker",
    draft_property: "MORRIS",
    draft_unit: "",
    draft_schedule_raw: "",
    knownPropertyCodesUpper: known,
    propertiesList: props,
  });
  assert.equal(m.draft_unit, "401");
});

test("ISSUE stage — do not treat 'not' as unit token", () => {
  const m = mergeMaintenanceDraftTurn({
    bodyText:
      "my toilet is not flushing can someone come to check it please",
    expected: "ISSUE",
    draft_issue: "",
    draft_property: "",
    draft_unit: "",
    draft_schedule_raw: "",
    knownPropertyCodesUpper: known,
    propertiesList: props,
  });
  assert.equal(
    m.draft_unit,
    "",
    "unit must stay empty until UNIT stage (no false 't' from 'not')"
  );
});
