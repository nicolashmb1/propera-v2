const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  emptyImageMaintenanceSignal,
  extractImageMaintenanceSignal,
  parseImageMaintenanceSignal,
} = require("../src/brain/shared/mediaVisionProvider");

const DATA_URL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD";

function mockChatWithContent(content) {
  return async (req) => {
    assert.equal(req.apiKey, "test-key");
    assert.ok(req.body.messages[1].content.some((part) => part.type === "image_url"));
    return {
      ok: true,
      status: 200,
      data: {
        choices: [{ message: { content } }],
      },
    };
  };
}

describe("mediaVisionProvider", () => {
  test("parses valid OpenAI JSON response", async () => {
    const sig = await extractImageMaintenanceSignal({
      enabled: true,
      apiKey: "test-key",
      dataUrl: DATA_URL,
      bodyText: "# Penn 403",
      openaiChatCompletionsWithRetry: mockChatWithContent(
        JSON.stringify({
          kind: "photo",
          visualSummary: "Water appears below a sink cabinet.",
          syntheticBody: "Sink leaking under cabinet.",
          issueNameHint: "sink leaking",
          issueCategoryHint: "plumbing",
          urgencyHint: "urgent",
          safetyHint: "flood",
          confidence: { ocr: 0, visual: 0.85, issue: 0.82, propertyUnit: 0 },
          needsClarification: false,
        })
      ),
    });

    assert.equal(sig.kind, "photo");
    assert.equal(sig.syntheticBody, "Sink leaking under cabinet.");
    assert.equal(sig.issueNameHint, "sink leaking");
    assert.equal(sig.safetyHint, "flood");
    assert.equal(sig.needsClarification, false);
  });

  test("clamps confidence values", () => {
    const sig = parseImageMaintenanceSignal(
      JSON.stringify({
        kind: "photo",
        issueNameHint: "leak",
        confidence: { ocr: -1, visual: 1.2, issue: "0.5", propertyUnit: "bad" },
      })
    );

    assert.deepEqual(sig.confidence, {
      ocr: 0,
      visual: 1,
      issue: 0.5,
      propertyUnit: 0,
    });
  });

  test("handles malformed JSON safely", () => {
    const sig = parseImageMaintenanceSignal("not json");
    assert.equal(sig.kind, "unknown");
    assert.equal(sig.issueNameHint, "");
    assert.equal(sig.confidence.issue, 0);
    assert.equal(sig.needsClarification, true);
  });

  test("returns no-op when disabled", async () => {
    let called = false;
    const sig = await extractImageMaintenanceSignal({
      enabled: false,
      apiKey: "test-key",
      dataUrl: DATA_URL,
      openaiChatCompletionsWithRetry: async () => {
        called = true;
        return { ok: true, status: 200, data: {} };
      },
    });

    assert.deepEqual(sig, emptyImageMaintenanceSignal());
    assert.equal(called, false);
  });

  test("returns no-op when API key is missing", async () => {
    let called = false;
    const sig = await extractImageMaintenanceSignal({
      enabled: true,
      apiKey: "",
      dataUrl: DATA_URL,
      openaiChatCompletionsWithRetry: async () => {
        called = true;
        return { ok: true, status: 200, data: {} };
      },
    });

    assert.deepEqual(sig, emptyImageMaintenanceSignal());
    assert.equal(called, false);
  });

  test("screenshot text result preserves ocrText and syntheticBody", () => {
    const sig = parseImageMaintenanceSignal(
      JSON.stringify({
        kind: "screenshot_text",
        ocrText: "Unit 403 bathroom light is not working.",
        syntheticBody: "Unit 403 bathroom light is not working.",
        issueNameHint: "bathroom light not working",
        issueCategoryHint: "electrical",
        unitHint: "403",
        confidence: { ocr: 0.9, visual: 0.2, issue: 0.88, propertyUnit: 0.8 },
        needsClarification: false,
      })
    );

    assert.equal(sig.kind, "screenshot_text");
    assert.equal(sig.ocrText, "Unit 403 bathroom light is not working.");
    assert.equal(sig.syntheticBody, "Unit 403 bathroom light is not working.");
    assert.equal(sig.unitHint, "403");
  });

  test("unclear image result sets needsClarification", () => {
    const sig = parseImageMaintenanceSignal(
      JSON.stringify({
        kind: "unknown",
        visualSummary: "The image is too unclear to identify a maintenance issue.",
        syntheticBody: "",
        issueNameHint: "",
        confidence: { ocr: 0, visual: 0.2, issue: 0, propertyUnit: 0 },
        needsClarification: true,
      })
    );

    assert.equal(sig.kind, "unknown");
    assert.equal(sig.issueNameHint, "");
    assert.equal(sig.needsClarification, true);
  });
});
