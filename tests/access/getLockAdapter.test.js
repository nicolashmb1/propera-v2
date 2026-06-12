const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { getLockAdapter } = require("../../src/access/lockAdapter/getLockAdapter");

describe("getLockAdapter", () => {
  test("noop and seam providers resolve", () => {
    assert.equal(getLockAdapter("noop").issueCredential.name, "issueCredential");
    assert.equal(getLockAdapter("seam").issueCredential.name, "issueCredential");
  });

  test("unknown provider throws", () => {
    assert.throws(() => getLockAdapter("august"), /lock_adapter_not_implemented:august/);
  });
});
