const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildGaSessionUpdate,
  buildTurnDetection,
  GREETING_FALLBACK_MS,
} = require("../../src/voice/voiceWebSocketBridge");
const { buildMaxSystemPrompt } = require("../../src/voice/maxSystemPrompt");

describe("buildTurnDetection", () => {
  it("defaults to patient server_vad with long silence window", () => {
    const td = buildTurnDetection();
    assert.equal(td.type, "server_vad");
    assert.equal(td.interrupt_response, false);
    assert.ok(td.silence_duration_ms >= 1000);
  });
});

describe("buildGaSessionUpdate", () => {
  it("uses GA session shape with conservative turn detection", () => {
    const evt = buildGaSessionUpdate("Hello", "gpt-realtime-2");
    assert.equal(evt.type, "session.update");
    assert.equal(evt.session.type, "realtime");
    assert.equal(evt.session.model, "gpt-realtime-2");
    assert.deepEqual(evt.session.output_modalities, ["audio"]);
    assert.equal(evt.session.audio.input.format.type, "audio/pcmu");
    assert.equal(evt.session.audio.output.format.type, "audio/pcmu");
    assert.equal(evt.session.instructions, "Hello");
    assert.equal(evt.session.audio.input.turn_detection.interrupt_response, false);
    assert.equal(evt.session.audio.input.turn_detection.create_response, false);
    assert.equal(evt.session.audio.input.transcription.model, "gpt-4o-mini-transcribe");
    assert.ok(Array.isArray(evt.session.tools));
  });

  it("enables VAD auto-response when requested", () => {
    const evt = buildGaSessionUpdate("Hello", "gpt-realtime-2", { vadCreateResponse: true });
    assert.equal(evt.session.audio.input.turn_detection.create_response, true);
  });
});

describe("buildMaxSystemPrompt", () => {
  it("prioritizes wait-for-answer rules", () => {
    const prompt = buildMaxSystemPrompt({
      brandName: "Grand Management",
      brandShort: "Grand",
      propertyName: "The Grand at Penn",
      rosterKnown: true,
    });
    assert.match(prompt, /Wait for answers/i);
    assert.match(prompt, /ONE question per response/i);
    assert.match(prompt, /Never invent/i);
    assert.match(prompt, /neighbor/i);
  });

  it("unknown caller defers to step-by-step turns", () => {
    const prompt = buildMaxSystemPrompt({
      brandName: "Grand Management",
      brandShort: "Grand",
      propertyName: "The Grand at Penn",
      rosterKnown: false,
    });
    assert.match(prompt, /Unknown caller/i);
    assert.match(prompt, /NEW turn/i);
  });

  it("uses custom agent display name when provided", () => {
    const prompt = buildMaxSystemPrompt({
      brandName: "Grand Management",
      brandShort: "Grand",
      propertyName: "The Grand at Penn",
      agentName: "Alex",
    });
    assert.match(prompt, /You are Alex, maintenance assistant/i);
  });

  it("omits speech block when neutral", () => {
    const prompt = buildMaxSystemPrompt({
      brandName: "Grand",
      brandShort: "Grand",
      propertyName: "Penn",
      speakingStyle: "neutral",
    });
    assert.doesNotMatch(prompt, /## Speech/);
  });
});

describe("voice bridge timing", () => {
  it("uses conservative greeting fallback", () => {
    assert.ok(GREETING_FALLBACK_MS >= 1000);
  });
});
