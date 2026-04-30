/**
 * GAS-shaped compileTurn + deterministic intake package (no OpenAI in CI).
 */
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

describe("compileTurn + properaBuildIntakePackage (deterministic)", () => {
  let prevCompile;
  let prevLlm;

  beforeEach(() => {
    prevCompile = process.env.INTAKE_COMPILE_TURN;
    prevLlm = process.env.INTAKE_LLM_ENABLED;
    process.env.INTAKE_COMPILE_TURN = "1";
    process.env.INTAKE_LLM_ENABLED = "0";
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (prevCompile === undefined) delete process.env.INTAKE_COMPILE_TURN;
    else process.env.INTAKE_COMPILE_TURN = prevCompile;
    if (prevLlm === undefined) delete process.env.INTAKE_LLM_ENABLED;
    else process.env.INTAKE_LLM_ENABLED = prevLlm;
  });

  test("compileTurn returns turnFacts with issue and safety shape", async () => {
    const { compileTurn } = require("../src/brain/intake/compileTurn");
    const known = new Set(["PENN", "MURRAY"]);
    const tf = await compileTurn(
      "sink leaking 303 penn",
      "TG:1",
      "en",
      {},
      null,
      { knownPropertyCodesUpper: known }
    );
    assert.equal(typeof tf.safety.isEmergency, "boolean");
    assert.ok(String(tf.issue || "").length > 0);
    assert.ok(tf.__properaIntakePackage === true || tf.issue);
  });

  test("parseMaintenanceDraftAsync uses compile path when INTAKE_COMPILE_TURN=1", async () => {
    const {
      parseMaintenanceDraftAsync,
    } = require("../src/brain/core/parseMaintenanceDraft");
    const known = new Set(["PENN"]);
    const d = await parseMaintenanceDraftAsync("sink leaking 303 penn", known);
    assert.ok(d.propertyCode || d.unitLabel || d.issueText);
    assert.equal(typeof d.openerNext, "string");
    assert.equal(typeof d.scheduleRaw, "string");
  });

  test("compile path keeps property empty for non-explicit mention", async () => {
    const { parseMaintenanceDraftAsync } = require("../src/brain/core/parseMaintenanceDraft");
    const known = new Set(["MORRIS"]);
    const props = [
      { code: "MORRIS", display_name: "Property MORRIS", aliases: ["morris"] },
    ];
    const d = await parseMaintenanceDraftAsync("can you come tomorrow morning", known, {
      propertiesList: props,
    });
    assert.equal(d.propertyCode, "");
    assert.equal(d.openerNext, "SCHEDULE");
  });

  test("compile path marks common area location from issue text", async () => {
    const { parseMaintenanceDraftAsync } = require("../src/brain/core/parseMaintenanceDraft");
    const known = new Set(["PENN"]);
    const d = await parseMaintenanceDraftAsync(
      "hallway leak at penn by unit 101",
      known
    );
    assert.equal(d.locationType, "COMMON_AREA");
  });
});
