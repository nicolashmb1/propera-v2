/**
 * GAS `properaCanonizeStructuredSignal_` — property grounding vs `07_PROPERA_INTAKE_PACKAGE.gs` ~1399–1426.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  properaCanonizeStructuredSignal,
} = require("../src/brain/intake/canonizeStructuredSignal");

describe("properaCanonizeStructuredSignal (GAS grounding)", () => {
  const props = [
    {
      code: "PENN",
      display_name: "Penn Apartments",
      short_name: "penn",
    },
  ];

  test("with propertiesList: clears hallucinated LLM property not in message", () => {
    const raw = {
      actorType: "TENANT",
      turnType: "OPERATIONAL_ONLY",
      issues: [{ summary: "Sink leak", title: "Sink leak" }],
      propertyCode: "FAKE",
      propertyName: "Fake Tower",
      confidence: 0.9,
    };
    const out = properaCanonizeStructuredSignal(
      raw,
      "+1",
      "llm",
      "sink is leaking badly",
      props
    );
    assert.equal(out.propertyCode, "");
    assert.equal(out.propertyName, "");
  });

  test("with propertiesList: strict phrase grounds PENN (GAS resolvePropertyFromText strict)", () => {
    const raw = {
      actorType: "TENANT",
      turnType: "OPERATIONAL_ONLY",
      issues: [{ summary: "Leak", title: "Leak" }],
      propertyCode: "WRONG",
      confidence: 0.5,
    };
    const out = properaCanonizeStructuredSignal(
      raw,
      "+1",
      "llm",
      "there is a leak at penn apartments unit 4",
      props
    );
    assert.equal(out.propertyCode, "PENN");
    assert.match(out.propertyName, /Penn/i);
  });

  test("without propertiesList: legacy word-boundary on raw propertyCode", () => {
    const raw = {
      actorType: "TENANT",
      turnType: "OPERATIONAL_ONLY",
      issues: [{ summary: "x", title: "x" }],
      propertyCode: "PENN",
      confidence: 0.5,
    };
    const out = properaCanonizeStructuredSignal(
      raw,
      "+1",
      "llm",
      "issue at PENN building",
      []
    );
    assert.equal(out.propertyCode, "PENN");
  });

  test("normalizeUnit_ on unit field (GAS 17 ~2247–2258)", () => {
    const raw = {
      actorType: "TENANT",
      turnType: "OPERATIONAL_ONLY",
      issues: [{ summary: "x", title: "x" }],
      unit: "apt 402b",
      confidence: 0.5,
    };
    const out = properaCanonizeStructuredSignal(raw, "+1", "llm", "", []);
    assert.equal(out.unit, "402B");
  });

  test("access_notes becomes schedule.raw when schedule missing (GAS ~1392–1394)", () => {
    const raw = {
      actorType: "TENANT",
      turnType: "OPERATIONAL_ONLY",
      issues: [{ summary: "x", title: "x" }],
      access_notes: "tomorrow 9am",
      confidence: 0.5,
    };
    const out = properaCanonizeStructuredSignal(raw, "+1", "llm", "", []);
    assert.ok(out.schedule && out.schedule.raw);
    assert.match(out.schedule.raw, /tomorrow 9am/i);
  });
});
