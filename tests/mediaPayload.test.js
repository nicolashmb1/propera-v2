const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseMediaJson,
  mediaTextHints,
  composeInboundTextWithMedia,
} = require("../src/brain/shared/mediaPayload");
const { normalizeInboundEventFromRouterParameter } = require("../src/brain/router/normalizeInboundEvent");

describe("mediaPayload (channel-agnostic media bridge)", () => {
  test("parseMediaJson returns [] for invalid input", () => {
    assert.deepEqual(parseMediaJson("not-json"), []);
    assert.deepEqual(parseMediaJson("{}"), []);
  });

  test("mediaTextHints collects OCR/text fields", () => {
    const hints = mediaTextHints([
      { ocr_text: "Leak in unit 303" },
      { transcript: "please send someone" },
    ]);
    assert.equal(hints.length, 2);
    assert.equal(hints[0], "Leak in unit 303");
  });

  test("composeInboundTextWithMedia appends media hints", () => {
    const txt = composeInboundTextWithMedia(
      "photo attached",
      [{ ocr_text: "Sink leaking in 303 penn" }],
      500
    );
    assert.ok(txt.includes("photo attached"));
    assert.ok(txt.includes("Sink leaking in 303 penn"));
  });
});

describe("normalizeInboundEvent media pass-through", () => {
  test("reads _mediaJson into event.media + numMedia", () => {
    const media = [{ kind: "image", ocr_text: "ticket text" }];
    const ev = normalizeInboundEventFromRouterParameter({
      From: "TG:1",
      Body: "caption text",
      _channel: "TELEGRAM",
      _mediaJson: JSON.stringify(media),
    });
    assert.equal(Array.isArray(ev.media), true);
    assert.equal(ev.media.length, 1);
    assert.equal(ev.meta.numMedia, "1");
  });
});
