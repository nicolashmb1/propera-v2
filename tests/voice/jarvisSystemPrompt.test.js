const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildJarvisSystemPrompt } = require("../../src/voice/jarvisSystemPrompt");

describe("buildJarvisSystemPrompt", () => {
  it("greets staff by first name without capability menu", () => {
    const p = buildJarvisSystemPrompt({
      staffDisplayName: "Nicolas Dupont",
      sessionContextBlock: "## context",
    });
    assert.match(p, /Nicolas/);
    assert.match(p, /Do NOT list tools/i);
    assert.match(p, /how can I help/i);
    assert.match(p, /resolve_open_ticket/i);
    assert.match(p, /LEAN field work only/i);
    assert.match(p, /propose_create_service_request/i);
    assert.match(p, /Multiple tickets same unit/i);
    assert.match(p, /propose_schedule_ticket/i);
    assert.match(p, /## context/);
  });

  it("advertises the reasoning-loop capabilities so voice routes them to ask_propera", () => {
    const p = buildJarvisSystemPrompt({ staffDisplayName: "Nick" });
    assert.match(p, /Equipment:.*make\/model\/serial/i);
    assert.match(p, /Diagnosis:.*POSSIBLE causes/i);
    assert.match(p, /Parts:.*ask_propera/i);
    assert.match(p, /never claim a price or which is 'cheapest'/i);
  });

  it("uses custom agent display name when provided", () => {
    const p = buildJarvisSystemPrompt({ agentName: "Nova" });
    assert.match(p, /You are Nova, Propera's staff operations assistant/i);
  });
});
