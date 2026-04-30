const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRouterParameterFromTwilio,
} = require("../src/contracts/buildRouterParameterFromTwilio");
const {
  normalizeImageMime,
} = require("../src/adapters/twilio/fetchTwilioMediaAsDataUrl");

describe("buildRouterParameterFromTwilio media", () => {
  test("sets kind=image for image/jpeg", () => {
    const p = buildRouterParameterFromTwilio({
      From: "+15551234567",
      Body: "see photo",
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages/MMxxx/Media/MExxx",
      MediaContentType0: "image/jpeg",
    });
    const raw = JSON.parse(p._mediaJson || "[]");
    assert.equal(raw.length, 1);
    assert.equal(raw[0].kind, "image");
    assert.equal(raw[0].source, "twilio");
  });
});

describe("normalizeImageMime", () => {
  test("octet-stream + jpeg hint → jpeg", () => {
    assert.equal(
      normalizeImageMime("application/octet-stream", "image/jpeg"),
      "image/jpeg"
    );
  });
});
