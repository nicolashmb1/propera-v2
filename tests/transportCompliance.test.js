const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { complianceSmsOnly } = require("../src/inbound/transportCompliance");

describe("transportCompliance", () => {
  test("SMS only for TCPA-style compliance", () => {
    assert.equal(complianceSmsOnly("sms"), true);
    assert.equal(complianceSmsOnly("whatsapp"), false);
    assert.equal(complianceSmsOnly("telegram"), false);
  });
});
