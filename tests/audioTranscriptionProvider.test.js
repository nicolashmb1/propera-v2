"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  isAudioMediaItem,
  mimeAllowedForAudio,
  isStoragePathAllowed,
  transcribeInboundAudioMediaItem,
} = require("../src/media/audioTranscriptionProvider");

describe("audioTranscriptionProvider", () => {
  test("isAudioMediaItem detects kind aliases and audio mime", () => {
    assert.equal(isAudioMediaItem({ kind: "voice" }), true);
    assert.equal(isAudioMediaItem({ kind: "audio" }), true);
    assert.equal(isAudioMediaItem({ kind: "image", mimeType: "audio/webm" }), true);
    assert.equal(isAudioMediaItem({ kind: "image" }), false);
  });

  test("mimeAllowedForAudio", () => {
    assert.equal(mimeAllowedForAudio("audio/webm"), true);
    assert.equal(mimeAllowedForAudio("audio/ogg"), true);
    assert.equal(mimeAllowedForAudio("text/plain"), false);
  });

  test("isStoragePathAllowed rejects traversal and wrong prefix", () => {
    assert.equal(isStoragePathAllowed("portal-chat-audio/x.webm", "portal-chat-audio"), true);
    assert.equal(isStoragePathAllowed("../portal-chat-audio/x", "portal-chat-audio"), false);
    assert.equal(isStoragePathAllowed("other/x", "portal-chat-audio"), false);
  });

  test("transcribeInboundAudioMediaItem skips when intake audio disabled (env default)", async () => {
    const r = await transcribeInboundAudioMediaItem(
      { kind: "audio", storagePath: "portal-chat-audio/a.webm", mimeType: "audio/webm" },
      { transportChannel: "portal", sb: {} }
    );
    assert.equal(r.ok, false);
    assert.ok(r.errorCode);
  });
});
