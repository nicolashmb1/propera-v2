const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  issueHeadFromStructuredIssues,
  issueClausePartsFromStructuredIssues,
} = require("../src/brain/intake/properaBuildIntakePackage");

describe("issueHeadFromStructuredIssues", () => {
  test("empty", () => {
    assert.equal(issueHeadFromStructuredIssues([]), "");
    assert.equal(issueHeadFromStructuredIssues(null), "");
  });

  test("single issue", () => {
    assert.equal(
      issueHeadFromStructuredIssues([
        { title: "Clogged sink", summary: "Kitchen sink clogged" },
      ]),
      "Kitchen sink clogged"
    );
  });

  test("multiple distinct issues joined with and", () => {
    const h = issueHeadFromStructuredIssues([
      { summary: "Sink is clogged" },
      { summary: "Ice maker not working" },
    ]);
    assert.equal(h, "Sink is clogged and Ice maker not working");
    assert.deepEqual(issueClausePartsFromStructuredIssues([
      { summary: "Sink is clogged" },
      { summary: "Ice maker not working" },
    ]), ["Sink is clogged", "Ice maker not working"]);
  });

  test("dedupe identical summary", () => {
    assert.equal(
      issueHeadFromStructuredIssues([
        { summary: "Same text" },
        { summary: "Same text" },
      ]),
      "Same text"
    );
  });
});
