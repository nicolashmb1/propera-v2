const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTicketAttachmentsFromRouterParameter,
} = require("../src/dal/finalizeMaintenance");

describe("finalizeMaintenance attachments from media contract", () => {
  test("empty when no media", () => {
    assert.equal(buildTicketAttachmentsFromRouterParameter({}), "");
    assert.equal(buildTicketAttachmentsFromRouterParameter({ _mediaJson: "" }), "");
  });

  test("uses url when available", () => {
    const out = buildTicketAttachmentsFromRouterParameter({
      _mediaJson: JSON.stringify([{ url: "https://example.com/img1.jpg" }]),
    });
    assert.equal(out, "https://example.com/img1.jpg");
  });

  test("falls back to telegram file id token", () => {
    const out = buildTicketAttachmentsFromRouterParameter({
      _mediaJson: JSON.stringify([{ provider: "telegram", file_id: "abc123" }]),
    });
    assert.equal(out, "telegram:abc123");
  });
});
