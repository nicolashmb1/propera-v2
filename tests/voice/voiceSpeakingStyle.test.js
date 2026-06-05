const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildSpeakingStylePromptBlock } = require("../../src/voice/voiceSpeakingStyle");
const { buildMaxSystemPrompt } = require("../../src/voice/maxSystemPrompt");
const { buildJarvisSystemPrompt } = require("../../src/voice/jarvisSystemPrompt");

describe("buildSpeakingStylePromptBlock", () => {
  it("returns empty for neutral", () => {
    assert.equal(buildSpeakingStylePromptBlock("neutral"), "");
    assert.equal(buildSpeakingStylePromptBlock("default"), "");
  });

  it("returns British accent block", () => {
    const block = buildSpeakingStylePromptBlock("british");
    assert.match(block, /British accent/i);
    assert.match(block, /stable/i);
  });

  it("returns empty for unknown style", () => {
    assert.equal(buildSpeakingStylePromptBlock("scottish"), "");
  });
});

describe("speaking style in prompts", () => {
  it("injects speech block into Max prompt when british", () => {
    const prompt = buildMaxSystemPrompt({
      brandName: "Grand",
      brandShort: "Grand",
      propertyName: "Penn",
      speakingStyle: "british",
    });
    assert.match(prompt, /British accent/i);
    assert.match(prompt, /Wait for answers/i);
  });

  it("injects speech block into Jarvis prompt when american", () => {
    const prompt = buildJarvisSystemPrompt({ speakingStyle: "american" });
    assert.match(prompt, /American accent/i);
    assert.match(prompt, /Your job/i);
  });
});
