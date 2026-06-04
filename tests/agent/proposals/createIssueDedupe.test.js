const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  issuesAreDuplicate,
} = require("../../../src/agent/proposals/createIssueDedupe");

describe("createIssueDedupe", () => {
  it("treats similar fridge phrases as duplicate", () => {
    assert.equal(
      issuesAreDuplicate("refrigerator not working", "refrigerator is not working"),
      true
    );
  });

  it("allows different issues same unit", () => {
    assert.equal(
      issuesAreDuplicate("refrigerator not working", "AC machine not working"),
      false
    );
  });
});
