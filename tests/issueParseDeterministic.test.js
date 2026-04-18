/**
 * GAS `issueParseDeterministic_` — `09_ISSUE_CLASSIFICATION_ENGINE.gs` (Node port).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseIssueDeterministic,
  _issueParseTestExports,
} = require("../src/brain/gas/issueParseDeterministic");

describe("parseIssueDeterministic (GAS parity)", () => {
  it("extracts problem clause when message is symptom-first (not a schedule request)", () => {
    const p = parseIssueDeterministic("my tub is clogged", {});
    assert.ok(String(p.title || p.bestClauseText).toLowerCase().includes("clog"));
    assert.ok(p.problemSpanCount >= 1);
  });

  it("classifies schedule-like clause separately from problem", () => {
    const p = parseIssueDeterministic(
      "sink is leaking. tomorrow morning works for maintenance",
      {}
    );
    assert.ok(String(p.title || "").length > 0);
    assert.match(p.debug, /picked=/);
  });

  it("exports clause classifier for regression", () => {
    assert.equal(
      _issueParseTestExports.issueClassifyClauseType_("sink is leaking"),
      "problem"
    );
    assert.equal(_issueParseTestExports.looksLikeGreetingOnly_("hello"), true);
    assert.equal(
      _issueParseTestExports.isScheduleWindowLike_("tomorrow 9am"),
      true
    );
  });
});
