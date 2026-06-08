"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeAudienceFilter,
  buildAudiencePreview,
} = require("../src/communication/audienceResolver");
const { getAudienceLabel } = require("../src/communication/brandContextService");

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
    MORRIS: {
      code: "MORRIS",
      displayName: "The Grand at Morris",
      displayNameShort: "Morris",
      senderLabel: "Management at The Grand at Morris",
    },
  },
};

describe("communication audience helpers", () => {
  test("normalizeAudienceFilter trims, uppercases, dedupes, and lowercases ids", () => {
    const out = normalizeAudienceFilter({
      property_codes: [" penn ", "PENN", "morris"],
      floors: [" 3 ", "3", 4],
      unit_ids: ["ABC", "abc", "def"],
      tenant_ids: ["TEN1", "ten1", "TEN2"],
    });

    assert.deepEqual(out, {
      property_codes: ["PENN", "MORRIS"],
      floors: ["3", "4"],
      unit_ids: ["abc", "def"],
      tenant_ids: ["ten1", "ten2"],
      // Normalized filter also carries delivery-mode defaults consumed by
      // resolveAudience / campaignService / tenantNoticesService.
      include_tenant_portal: true,
      delivery_mode: "sms_and_portal",
    });
  });

  test("getAudienceLabel uses tenant-facing property names", () => {
    const propertyLabel = getAudienceLabel(BRAND_CONTEXT, "PROPERTY", {
      property_codes: ["PENN"],
    });
    assert.equal(propertyLabel, "all residents at The Grand at Penn");

    const floorLabel = getAudienceLabel(BRAND_CONTEXT, "FLOOR", {
      property_codes: ["PENN"],
      floors: ["3"],
    });
    assert.equal(floorLabel, "floor 3 residents at The Grand at Penn");
  });

  test("buildAudiencePreview counts sendable and skipped rows by property", () => {
    const preview = buildAudiencePreview({
      brandContext: BRAND_CONTEXT,
      audienceKind: "PROPERTY",
      audienceFilter: { property_codes: ["PENN", "MORRIS"] },
      skippedNoUnit: 2,
      recipients: [
        {
          propertyCode: "PENN",
          displayName: "The Grand at Penn",
          unitLabel: "301",
          name: "Jane Doe",
          phone: "+19085550111",
          skipReason: "",
        },
        {
          propertyCode: "PENN",
          displayName: "The Grand at Penn",
          unitLabel: "302",
          name: "John Doe",
          phone: "",
          skipReason: "NO_PHONE",
        },
        {
          propertyCode: "MORRIS",
          displayName: "The Grand at Morris",
          unitLabel: "1A",
          name: "Alex Smith",
          phone: "+19085550122",
          skipReason: "OPT_OUT",
        },
      ],
    });

    assert.equal(preview.total, 3);
    assert.equal(preview.willSend, 1);
    assert.equal(preview.skippedNoPhone, 1);
    assert.equal(preview.skippedOptOut, 1);
    assert.equal(preview.skippedNoUnit, 2);
    assert.equal(preview.byProperty.length, 2);
    assert.deepEqual(preview.byProperty[0], {
      propertyCode: "MORRIS",
      displayName: "The Grand at Morris",
      total: 1,
      willSend: 0,
      skippedNoPhone: 0,
      skippedOptOut: 1,
    });
    assert.deepEqual(preview.byProperty[1], {
      propertyCode: "PENN",
      displayName: "The Grand at Penn",
      total: 2,
      willSend: 1,
      skippedNoPhone: 1,
      skippedOptOut: 0,
    });
  });
});
