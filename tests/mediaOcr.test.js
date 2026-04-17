const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { enrichMediaWithOcr } = require("../src/brain/shared/mediaOcr");

describe("media OCR orchestrator (channel-agnostic)", () => {
  test("no-op when disabled", async () => {
    const out = await enrichMediaWithOcr([{ kind: "image", file_id: "x" }], {
      enabled: false,
      ocrOne: async () => "hello",
    });
    assert.equal(out[0].ocr_text, undefined);
  });

  test("adds ocr_text for image when provided", async () => {
    const out = await enrichMediaWithOcr([{ kind: "image", file_id: "x" }], {
      enabled: true,
      ocrOne: async () => "Leak in unit 303",
    });
    assert.equal(out[0].ocr_text, "Leak in unit 303");
  });
});
