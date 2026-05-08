"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildOutboundIntent } = require("../src/outgate/outboundIntent");
const { renderOutboundIntent } = require("../src/outgate/renderOutboundIntent");
const {
  COMPLIANCE_STOP,
  messageSpecForComplianceBrain,
} = require("../src/outgate/messageSpecs");

test("buildOutboundIntent fills defaults", () => {
  const i = buildOutboundIntent({
    intentType: "CORE_foo",
    replyText: "hello",
    traceId: "t1",
  });
  assert.equal(i.intentType, "CORE_foo");
  assert.equal(i.replyText, "hello");
  assert.equal(i.audience, "unknown");
});

test("renderOutboundIntent prefers intent.replyText over MessageSpec when both set", () => {
  const intent = buildOutboundIntent({
    intentType: "COMPLIANCE_STOP",
    replyText: "custom override body",
    traceId: "t1",
  });
  const r = renderOutboundIntent({ intent, messageSpec: COMPLIANCE_STOP });
  assert.equal(r.body, "custom override body");
  assert.equal(r.meta.templateKey, "COMPLIANCE_STOP");
  assert.equal(r.meta.renderSource, "intent_reply_text");
});

test("renderOutboundIntent uses MessageSpec fallback when intent reply empty", () => {
  const intent = buildOutboundIntent({
    intentType: "COMPLIANCE_STOP",
    replyText: "",
    traceId: "t1",
  });
  const r = renderOutboundIntent({ intent, messageSpec: COMPLIANCE_STOP });
  assert.ok(r.body.includes("unsubscribed"));
  assert.equal(r.meta.templateKey, "COMPLIANCE_STOP");
  assert.equal(r.meta.renderSource, "message_spec_fallback");
});

test("renderOutboundIntent uses intent.replyText without spec", () => {
  const intent = buildOutboundIntent({
    intentType: "CORE_REPLY",
    replyText: "Tenant copy",
    traceId: "t1",
  });
  const r = renderOutboundIntent({ intent, messageSpec: null });
  assert.equal(r.body, "Tenant copy");
  assert.equal(r.meta.templateKey, null);
  assert.equal(r.meta.renderSource, "intent_reply_text");
  assert.equal(r.meta.maintenanceTemplateKey, null);
});

test("renderOutboundIntent passes through coreOutgate template key", () => {
  const intent = buildOutboundIntent({
    intentType: "CORE_core_draft_pending",
    replyText: "What unit?",
    traceId: "t1",
    facts: {
      coreOutgate: {
        templateKey: "MAINTENANCE_UNIT",
        promptComposite: null,
      },
    },
  });
  const r = renderOutboundIntent({ intent, messageSpec: null });
  assert.equal(r.meta.maintenanceTemplateKey, "MAINTENANCE_UNIT");
  assert.equal(r.meta.coreOutgate.templateKey, "MAINTENANCE_UNIT");
});

test("messageSpecForComplianceBrain maps brain keys", () => {
  assert.equal(messageSpecForComplianceBrain("compliance_stop").templateKey, "COMPLIANCE_STOP");
  assert.equal(messageSpecForComplianceBrain("nope"), null);
});
