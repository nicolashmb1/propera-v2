const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  enrichInboundMediaWithOcr,
  normalizeInboundMediaProvider,
} = require("../src/brain/shared/enrichInboundMediaWithOcr");
const { enrichMediaWithOcr } = require("../src/brain/shared/mediaOcr");
const {
  buildRouterParameterFromTwilio,
} = require("../src/contracts/buildRouterParameterFromTwilio");
const { normalizeTelegramUpdate } = require("../src/adapters/telegram/normalizeTelegramUpdate");
const {
  buildRouterParameterFromTelegram,
} = require("../src/contracts/buildRouterParameterFromTelegram");

describe("normalizeInboundMediaProvider", () => {
  test("prefers provider twilio", () => {
    assert.equal(
      normalizeInboundMediaProvider({ provider: "twilio", url: "https://x" }),
      "twilio"
    );
  });

  test("falls back to source twilio", () => {
    assert.equal(
      normalizeInboundMediaProvider({ source: "twilio", url: "https://x" }),
      "twilio"
    );
  });

  test("provider telegram", () => {
    assert.equal(
      normalizeInboundMediaProvider({ provider: "telegram", file_id: "abc" }),
      "telegram"
    );
  });

  test("infers telegram when file_id present and no url", () => {
    assert.equal(normalizeInboundMediaProvider({ file_id: "abc", kind: "image" }), "telegram");
  });

  test("does not infer telegram when url present (Twilio)", () => {
    assert.equal(
      normalizeInboundMediaProvider({
        url: "https://api.twilio.com/Media/x",
        source: "twilio",
      }),
      "twilio"
    );
  });
});

describe("enrichInboundMediaWithOcr — single checkpoint", () => {
  test("Twilio + Telegram shaped items from real RouterParameter builders share one enrichMediaWithOcr pass", async () => {
    const tw = buildRouterParameterFromTwilio({
      From: "+15551234567",
      Body: "pic",
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.com/Media/MX",
      MediaContentType0: "image/png",
    });
    const signal = normalizeTelegramUpdate({
      update_id: 202,
      message: {
        message_id: 9,
        from: { id: 111 },
        chat: { id: 222 },
        photo: [{ file_id: "a" }, { file_id: "big", file_unique_id: "u" }],
      },
    });
    assert.ok(signal);
    const tg = buildRouterParameterFromTelegram(signal, {});

    const twilioItems = JSON.parse(tw._mediaJson || "[]");
    const telegramItems = JSON.parse(tg._mediaJson || "[]");
    assert.equal(twilioItems[0].provider, "twilio");
    assert.equal(telegramItems[0].provider, "telegram");

    const mixed = [...twilioItems, ...telegramItems];

    let enrichPasses = 0;
    const providersSeen = [];

    await enrichInboundMediaWithOcr(mixed, {
      deps: {
        enrichMediaWithOcr: async (list, opts) => {
          enrichPasses++;
          assert.equal(typeof opts.ocrOne, "function");
          assert.equal(list.length, 2);
          const out = [];
          for (const item of list) {
            providersSeen.push(normalizeInboundMediaProvider(item));
            const tag =
              normalizeInboundMediaProvider(item) === "twilio" ? "TW" : "TG";
            const copy = { ...item, ocr_text: `[mock-${tag}]` };
            out.push(copy);
          }
          return out;
        },
      },
    });

    assert.equal(enrichPasses, 1);
    assert.deepEqual(providersSeen.sort(), ["telegram", "twilio"]);
  });

  test("does not call ocrOne when ocr_text already set (no double OCR)", async () => {
    let ocrOneCalls = 0;
    await enrichInboundMediaWithOcr(
      [
        {
          provider: "twilio",
          source: "twilio",
          url: "https://example.com/m.jpg",
          kind: "image",
          contentType: "image/jpeg",
          ocr_text: "already extracted",
        },
      ],
      {
        deps: {
          enrichMediaWithOcr: async (list, opts) =>
            enrichMediaWithOcr(list, {
              ...opts,
              ocrOne: async (item) => {
                ocrOneCalls++;
                return opts.ocrOne(item);
              },
            }),
        },
      }
    );
    assert.equal(ocrOneCalls, 0);
  });
});
