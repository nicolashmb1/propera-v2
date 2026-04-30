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

  test("PORTAL channel sets source and channel to portal", () => {
    const ev = normalizeInboundEventFromRouterParameter({
      From: "+15551234567",
      Body: "# PENN apt 303 Plumbing: test",
      _channel: "PORTAL",
      _phoneE164: "+15551234567",
    });
    assert.equal(ev.source, "portal");
    assert.equal(ev.channel, "portal");
    assert.equal(ev.meta.portal, "1");
  });

  test("canonicalBrainActorKey on signal — actorId follows canonical, meta keeps transport", () => {
    const ev = normalizeInboundEventFromRouterParameter({
      From: "TG:305305305",
      Body: "# ice maker",
      _channel: "TELEGRAM",
      _canonicalBrainActorKey: "+15550001112",
    });
    assert.equal(ev.canonicalBrainActorKey, "+15550001112");
    assert.equal(ev.actorId, "+15550001112");
    assert.equal(ev.meta.transportActorKey, "TG:305305305");
    assert.equal(ev.meta.canonicalBrainActorKey, "+15550001112");
  });
});
