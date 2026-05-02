const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { buildIssueTicketGroups } = require("../src/brain/core/finalizeTicketGroups");

describe("multi-issue split grouping", () => {
  test("distinct systems split into two groups", () => {
    const input = "my ice maker is not working and ac does not run";
    const groups = buildIssueTicketGroups(input);
    assert.equal(groups.length, 2);
    assert.equal(
      groups.some((g) => String(g.issueText || "").toLowerCase().includes(input)),
      false
    );
  });

  test("same system sub-issues stay one group", () => {
    const groups = buildIssueTicketGroups(
      "ac filter needs to be changed and ac drain needs to be unclogged"
    );
    assert.equal(groups.length, 1);
  });
});
