const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mergeMaintenanceDraftTurn,
  resolvePropertyFromReply,
} = require("../src/brain/core/mergeMaintenanceDraft");

const known = new Set(["PENN", "MORRIS"]);
const props = [
  { code: "PENN", display_name: "Property PENN", aliases: ["penn building"] },
  { code: "MORRIS", display_name: "Property MORRIS", aliases: ["morris tower"] },
];

test("resolvePropertyFromReply — number index", () => {
  assert.equal(resolvePropertyFromReply("2", props), "MORRIS");
});

test("resolvePropertyFromReply — code token", () => {
  assert.equal(resolvePropertyFromReply("MORRIS", props), "MORRIS");
});

test("resolvePropertyFromReply — strong name token", () => {
  assert.equal(resolvePropertyFromReply("issue at morris building", props), "MORRIS");
});

test("resolvePropertyFromReply — db alias token", () => {
  assert.equal(resolvePropertyFromReply("problem at penn building", props), "PENN");
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

test("merge uses parsedDraft from async intake when provided", () => {
  const m = mergeMaintenanceDraftTurn({
    bodyText: "this text should not win",
    expected: "ISSUE",
    draft_issue: "",
    draft_property: "",
    draft_unit: "",
    draft_schedule_raw: "",
    knownPropertyCodesUpper: known,
    propertiesList: props,
    parsedDraft: {
      propertyCode: "PENN",
      unitLabel: "",
      issueText: "compiled intake issue",
    },
  });
  assert.equal(m.draft_issue, "compiled intake issue");
  assert.equal(m.draft_property, "PENN");
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
