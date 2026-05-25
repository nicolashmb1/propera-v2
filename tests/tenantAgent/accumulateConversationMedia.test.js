"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mergeMediaJsonStrings,
  accumulatePartialPackageMedia,
  resolveHandoffMediaJson,
} = require("../../src/adapters/tenantAgent/accumulateConversationMedia");
const {
  buildHandoffRouterParameterFromAgent,
} = require("../../src/adapters/tenantAgent/buildHandoffRouterParameter");
const {
  buildTicketAttachmentsFromRouterParameter,
} = require("../../src/dal/finalizeMaintenance");

test("mergeMediaJsonStrings dedupes telegram file ids", () => {
  const turn1 = JSON.stringify([{ provider: "telegram", file_id: "photo-1" }]);
  const turn2 = JSON.stringify([{ provider: "telegram", file_id: "photo-1" }]);
  const merged = mergeMediaJsonStrings(turn1, turn2);
  const arr = JSON.parse(merged);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].file_id, "photo-1");
});

test("accumulatePartialPackageMedia persists across turns", () => {
  const turn1 = JSON.stringify([{ provider: "telegram", file_id: "photo-1" }]);
  let partial = accumulatePartialPackageMedia({}, turn1);
  partial = accumulatePartialPackageMedia(partial, "");
  assert.equal(JSON.parse(partial._gathered_media_json).length, 1);

  const turn3 = JSON.stringify([{ url: "https://cdn.example.com/crack.jpg" }]);
  partial = accumulatePartialPackageMedia(partial, turn3);
  const stored = JSON.parse(partial._gathered_media_json);
  assert.equal(stored.length, 2);
});

test("resolveHandoffMediaJson merges stored gather media with current inbound", () => {
  const partial = {
    _gathered_media_json: JSON.stringify([{ provider: "telegram", file_id: "photo-1" }]),
  };
  const handoffJson = resolveHandoffMediaJson(partial, "");
  const rp = buildHandoffRouterParameterFromAgent({
    partialPackage: {
      property: "WEST",
      unit: "204",
      issue: "Ceiling crack in bathroom",
    },
    tenantActorKey: "TG:123",
    transportChannel: "telegram",
    conversationId: "conv-1",
    traceId: "trace-1",
    mediaJson: handoffJson,
  });

  assert.ok(String(rp._mediaJson || "").length > 2);
  const attachments = buildTicketAttachmentsFromRouterParameter(rp);
  assert.equal(attachments, "telegram:photo-1");
});
