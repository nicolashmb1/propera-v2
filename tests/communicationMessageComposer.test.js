"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  appendFooter,
  estimateSmsSegments,
  fallbackDraftMessage,
} = require("../src/communication/messageComposer");

const BRAND_CONTEXT = {
  orgId: "grand",
  orgBrandName: "The Grand Management Group",
  orgBrandShort: "The Grand",
  properties: {
    PENN: {
      code: "PENN",
      displayName: "The Grand at Penn",
      displayNameShort: "Penn",
      senderLabel: "Management at The Grand at Penn",
    },
  },
};

describe("communication messageComposer", () => {
  test("fallback draft keeps body concise for english notices", () => {
    const body = fallbackDraftMessage({
      brief: "the office will be closed on july 4th.",
      audienceLabel: "all residents at The Grand at Penn",
      commType: "BUILDING_UPDATE",
      language: "en",
    });

    assert.match(body, /Hello all residents at The Grand at Penn/i);
    assert.match(body, /office will be closed on july 4th/i);
  });

  test("appendFooter adds sender label and stop text, without a maintenance line", () => {
    const full = appendFooter(
      "Please note the office will close at 3 PM today.",
      BRAND_CONTEXT,
      "PENN",
      "+19085550000",
      "en",
      { isMultiProperty: false }
    );

    assert.match(full, /Please note the office will close at 3 PM today\./);
    assert.match(full, /Management at The Grand at Penn/);
    assert.match(full, /Reply STOP to opt out\./);
    // Maintenance/office redirect is intentionally omitted this phase, even when
    // a number is passed.
    assert.doesNotMatch(full, /For maintenance, call or text/);
  });

  test("appendFooter never includes a maintenance line when no number is configured", () => {
    const full = appendFooter(
      "Parking spots must be cleared by Friday.",
      BRAND_CONTEXT,
      "PENN",
      "",
      "en",
      { isMultiProperty: false }
    );

    assert.match(full, /Parking spots must be cleared by Friday\./);
    assert.match(full, /Management at The Grand at Penn/);
    assert.match(full, /Reply STOP to opt out\./);
    assert.doesNotMatch(full, /For maintenance, call or text/);
  });

  test("appendFooter uses the translated stop line for spanish, without a maintenance line", () => {
    const full = appendFooter(
      "La oficina estara cerrada manana.",
      BRAND_CONTEXT,
      "PENN",
      "+19085550000",
      "es",
      { isMultiProperty: false }
    );

    assert.match(full, /La oficina estara cerrada manana\./);
    assert.match(full, /Responda STOP para dejar de recibir mensajes\./);
    assert.doesNotMatch(full, /Para mantenimiento/);
  });

  test("estimateSmsSegments handles gsm and unicode messages", () => {
    const gsm = estimateSmsSegments("A".repeat(161));
    assert.equal(gsm.encoding, "GSM-7");
    assert.equal(gsm.segments, 2);
    assert.equal(gsm.perSegment, 153);

    const unicodeBody = String.fromCharCode(0x4f60).repeat(71);
    const unicode = estimateSmsSegments(unicodeBody);
    assert.equal(unicode.encoding, "UCS-2");
    assert.equal(unicode.segments, 2);
    assert.equal(unicode.perSegment, 67);
  });
});
