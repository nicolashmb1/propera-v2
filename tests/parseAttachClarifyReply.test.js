const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAttachClarifyReply,
} = require("../src/brain/gas/parseAttachClarifyReply");

describe("parseAttachClarifyReply (GAS 16_ROUTER)", () => {
  it("parses digits and NL markers", () => {
    assert.deepEqual(parseAttachClarifyReply("1"), {
      outcome: "attach",
      stripped: "",
    });
    assert.deepEqual(parseAttachClarifyReply("2"), {
      outcome: "start_new",
      stripped: "",
    });
    assert.equal(parseAttachClarifyReply("maybe").outcome, "");
    const same = parseAttachClarifyReply("same request, thanks");
    assert.equal(same.outcome, "attach");
    assert.match(same.stripped, /thanks/i);
  });
});
