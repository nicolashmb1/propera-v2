const test = require("node:test");
const assert = require("node:assert/strict");

const { buildConflictCourtesyNotice } = require("../src/conflictMediation/conflictNoticeOutgate");
const {
  validateIssueCourtesyNotice,
  validateReportPolicyViolationBody,
} = require("../src/conflictMediation/validateConflictAction");

test("buildConflictCourtesyNotice is neutral and policy-grounded", () => {
  const body = buildConflictCourtesyNotice({
    propertyLabel: "The Grand",
    subjectUnit: "505",
    policyTitle: "Trash and waste",
    enforceableText: "Do not leave bags in hallways.",
    noticeTier: "COURTESY",
  });
  assert.match(body, /The Grand — Courtesy notice/);
  assert.match(body, /Unit 505/);
  assert.match(body, /Trash and waste/);
  assert.match(body, /Do not leave bags in hallways/);
  assert.match(body, /building policy reminder/i);
  assert.doesNotMatch(body, /neighbor reported/i);
});

test("validateReportPolicyViolationBody requires property, unit, summary", () => {
  assert.equal(validateReportPolicyViolationBody({}).ok, false);
  const ok = validateReportPolicyViolationBody({
    propertyCode: "penn",
    subjectUnit: "302",
    summary: "Trash in hallway",
    policyId: "abc",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.propertyCode, "PENN");
  assert.equal(ok.payload.subjectUnit, "302");
});

test("validateIssueCourtesyNotice allows CASE_OPEN with policy", () => {
  const out = validateIssueCourtesyNotice({
    state: "CASE_OPEN",
    policy_id: "pol-1",
    current_notice_tier: null,
  });
  assert.equal(out.ok, true);
  assert.equal(out.tier, "COURTESY");
});

test("validateIssueCourtesyNotice rejects missing policy", () => {
  const out = validateIssueCourtesyNotice({
    state: "CASE_OPEN",
    policy_id: null,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, "policy_required");
});

test("validateIssueCourtesyNotice rejects POLICY_MATCH without notice", () => {
  const out = validateIssueCourtesyNotice({
    state: "POLICY_MATCH",
    policy_id: "pol-1",
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, "invalid_case_state_for_notice");
});
