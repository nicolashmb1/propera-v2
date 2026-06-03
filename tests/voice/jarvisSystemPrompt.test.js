const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildJarvisSystemPrompt } = require("../../src/voice/jarvisSystemPrompt");

describe("buildJarvisSystemPrompt", () => {
  it("greets staff by first name", () => {
    const p = buildJarvisSystemPrompt({
      staffDisplayName: "Nicolas Dupont",
      sessionContextBlock: "## context",
    });
    assert.match(p, /Nicolas/);
    assert.match(p, /resolve_open_ticket/i);
    assert.match(p, /## context/);
  });
});
