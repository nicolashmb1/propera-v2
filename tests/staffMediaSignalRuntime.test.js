const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  enrichInboundMediaWithSignals,
  parseMediaSignalsJson,
} = require("../src/brain/shared/mediaSignalRuntime");

describe("mediaSignalRuntime", () => {
  test("wraps OCR and injected vision facts without losing media refs", async () => {
    const input = [
      {
        provider: "twilio",
        source: "twilio",
        url: "https://example.com/sink.jpg",
        contentType: "image/jpeg",
        kind: "image",
      },
    ];

    const out = await enrichInboundMediaWithSignals(input, {
      bodyText: "#",
      channel: "sms",
      deps: {
        enrichInboundMediaWithOcr: async (list) =>
          list.map((m) => ({ ...m, ocr_text: "Unit 403 sink leak note" })),
        extractImageMaintenanceSignal: async () => ({
          kind: "photo",
          visualSummary: "Water visible below a sink.",
          syntheticBody: "sink leaking",
          issueNameHint: "sink leaking",
          issueCategoryHint: "plumbing",
          confidence: { ocr: 0.7, visual: 0.8, issue: 0.82, propertyUnit: 0 },
        }),
      },
    });

    assert.equal(out.media.length, 1);
    assert.equal(out.media[0].url, "https://example.com/sink.jpg");
    assert.equal(out.media[0].ocr_text, "Unit 403 sink leak note");
    assert.equal(out.mediaSignals.length, 1);
    assert.equal(out.mediaSignals[0].issueNameHint, "sink leaking");
    assert.equal(out.mediaSignals[0].syntheticBody, "sink leaking");
    assert.equal(out.mediaSignals[0].sourceChannel, "sms");
  });

  test("passes downloaded dataUrl to injected vision provider", async () => {
    let seenDataUrl = "";
    const out = await enrichInboundMediaWithSignals(
      [
        {
          provider: "telegram",
          file_id: "tg-file",
          contentType: "image/jpeg",
          kind: "image",
        },
      ],
      {
        bodyText: "#staff Penn 403",
        channel: "telegram",
        deps: {
          enrichInboundMediaWithOcr: async (list) => list,
          fetchImageDataUrlForSignal: async () => "data:image/jpeg;base64,abc",
          extractImageMaintenanceSignal: async (input) => {
            seenDataUrl = input.dataUrl;
            assert.equal(input.context.sourceChannel, "telegram");
            return {
              kind: "photo",
              issueNameHint: "sink leaking",
              confidence: { issue: 0.8 },
            };
          },
        },
      }
    );

    assert.equal(seenDataUrl, "data:image/jpeg;base64,abc");
    assert.equal(out.mediaSignals[0].issueNameHint, "sink leaking");
  });

  test("parseMediaSignalsJson is safe for missing or invalid payloads", () => {
    assert.deepEqual(parseMediaSignalsJson(""), []);
    assert.deepEqual(parseMediaSignalsJson("{bad"), []);
    assert.deepEqual(parseMediaSignalsJson(JSON.stringify([{ issueNameHint: "x" }])), [
      { issueNameHint: "x" },
    ]);
  });
});
