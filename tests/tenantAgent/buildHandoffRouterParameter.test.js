"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildHandoffRouterParameterFromAgent,
} = require("../../src/adapters/tenantAgent/buildHandoffRouterParameter");
const {
  buildStructuredPortalCreateDraft,
} = require("../../src/brain/core/portalStructuredCreateDraft");

test("buildHandoffRouterParameterFromAgent — tenant_agent structured create shape", () => {
  const rp = buildHandoffRouterParameterFromAgent({
    partialPackage: {
      property: "PENN",
      unit: "410",
      issue: "Heat not working since yesterday",
    },
    tenantActorKey: "+15551234001",
    transportChannel: "sms",
    conversationId: "conv-uuid-1",
    traceId: "trace-1",
  });

  assert.equal(rp._portalAction, "create_ticket");
  assert.equal(rp._portalChannel, "tenant_agent");
  assert.equal(rp._phoneE164, "+15551234001");
  assert.equal(rp.Body, "noop");
  assert.equal(rp._channel, "SMS");

  const payload = JSON.parse(rp._portalPayloadJson);
  assert.equal(payload.channel, "tenant_agent");
  assert.equal(payload.property_code, "PENN");
  assert.equal(payload.unit_label, "410");
  assert.equal(payload.message, "Heat not working since yesterday");
  assert.equal(payload.preferredWindow, "");
  assert.equal(payload.category, "HVAC");
  assert.equal(payload.postCreate.scheduleMode, "ASK_OPTIONAL");

  const known = new Set(["PENN"]);
  const list = [{ code: "PENN", display_name: "The Grand at Penn", ticket_prefix: "", short_name: "", aliases: [] }];
  const draft = buildStructuredPortalCreateDraft(rp, known, list);
  assert.ok(draft);
  assert.equal(draft.propertyCode, "PENN");
  assert.equal(draft.unitLabel, "410");
});

test("buildHandoffRouterParameterFromAgent — passes gathered media on handoff", () => {
  const mediaJson = JSON.stringify([
    { provider: "telegram", file_id: "AgACAgIAAxkBAAI" },
  ]);
  const rp = buildHandoffRouterParameterFromAgent({
    partialPackage: {
      property: "WEST",
      unit: "204",
      issue: "Ceiling crack in bathroom",
      _gathered_media_json: mediaJson,
    },
    tenantActorKey: "TG:7108534136",
    transportChannel: "telegram",
    conversationId: "conv-uuid-2",
    traceId: "trace-2",
    mediaJson,
  });

  const arr = JSON.parse(rp._mediaJson);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].file_id, "AgACAgIAAxkBAAI");
});

test("buildHandoffRouterParameterFromAgent — security urgent skips schedule without emergency flag", () => {
  const rp = buildHandoffRouterParameterFromAgent({
    partialPackage: {
      property: "PENN",
      unit: "303",
      issue: "Apartment door deadbolt will not lock securely",
      _safety: {
        isEmergency: true,
        emergencyType: "SECURITY",
        skipScheduling: true,
        receiptTier: "urgent",
      },
    },
    tenantActorKey: "+15551234001",
    transportChannel: "sms",
    conversationId: "conv-uuid-3",
    traceId: "trace-3",
  });

  const payload = JSON.parse(rp._portalPayloadJson);
  assert.equal(payload.urgency, "URGENT");
  assert.equal(payload.preferredWindow, "");
  assert.equal(payload.emergency, undefined);
  assert.equal(payload.postCreate.scheduleMode, "NONE");
});
