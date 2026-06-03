const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectLanguage,
  resolveEffectiveContentLocale,
} = require("../src/tenant/detectTextLanguage");

describe("detectTextLanguage", () => {
  test("detects Spanish maintenance text", () => {
    assert.equal(
      detectLanguage("Hay una fuga de agua en la cocina desde ayer"),
      "es"
    );
    assert.equal(detectLanguage("El grifo no funciona en el baño"), "es");
  });

  test("detects English maintenance text", () => {
    assert.equal(
      detectLanguage("Water leak in the kitchen since yesterday"),
      "en"
    );
    assert.equal(detectLanguage("The heater is not working"), "en");
  });

  test("resolveEffectiveContentLocale uses profile when unknown", () => {
    assert.equal(resolveEffectiveContentLocale("unknown", "es"), "es");
    assert.equal(resolveEffectiveContentLocale("unknown", "en"), "en");
    assert.equal(resolveEffectiveContentLocale("es", "en"), "es");
  });
});
