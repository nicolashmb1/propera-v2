const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildJarvisGaSessionUpdate,
} = require("../../src/voice/jarvisVoiceWebSocketBridge");
const { jarvisVoiceToolSchemas } = require("../../src/voice/jarvisVoiceTools");

describe("buildJarvisGaSessionUpdate", () => {
  it("uses pcm 24kHz and core tools", () => {
    const evt = buildJarvisGaSessionUpdate("Hello staff", "gpt-realtime-2");
    assert.equal(evt.session.model, "gpt-realtime-2");
    assert.equal(evt.session.audio.input.format.type, "audio/pcm");
    assert.equal(evt.session.audio.input.format.rate, 24000);
    const names = jarvisVoiceToolSchemas().map((t) => t.name);
    assert.ok(names.includes("ask_propera"));
    assert.ok(names.includes("resolve_open_ticket"));
  });
});
