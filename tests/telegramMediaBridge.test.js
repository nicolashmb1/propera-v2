const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTelegramUpdate } = require("../src/adapters/telegram/normalizeTelegramUpdate");
const {
  buildRouterParameterFromTelegram,
} = require("../src/contracts/buildRouterParameterFromTelegram");

describe("telegram adapter media bridge", () => {
  test("normalizeTelegramUpdate captures photo metadata", () => {
    const signal = normalizeTelegramUpdate({
      update_id: 101,
      message: {
        message_id: 55,
        from: { id: 999 },
        chat: { id: 222 },
        caption: "see screenshot",
        photo: [{ file_id: "small" }, { file_id: "best", file_unique_id: "u1" }],
      },
    });
    assert.ok(signal);
    assert.equal(Array.isArray(signal.body.media), true);
    assert.equal(signal.body.media.length, 1);
    assert.equal(signal.body.media[0].file_id, "best");
    assert.equal(signal.body.media[0].provider, "telegram");
  });

  test("buildRouterParameterFromTelegram emits _mediaJson when media exists", () => {
    const signal = normalizeTelegramUpdate({
      update_id: 101,
      message: {
        message_id: 55,
        from: { id: 999 },
        chat: { id: 222 },
        caption: "photo only",
        photo: [{ file_id: "best", file_unique_id: "u1" }],
      },
    });
    const p = buildRouterParameterFromTelegram(signal, {});
    assert.ok(String(p._mediaJson || "").length > 2);
    const parsed = JSON.parse(p._mediaJson);
    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed.length, 1);
  });
});
