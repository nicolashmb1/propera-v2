"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  renderForChannel,
  applyTelegramMarkdown,
  SMS_COMPLIANCE_FOOTER,
} = require("../src/outgate/renderForChannel");

test("renderForChannel — SMS first contact adds header and footer", () => {
  const r = renderForChannel({
    transportChannel: "sms",
    body: "Ref #PENN-001 — we're on it.",
    audience: "tenant",
    includeFirstContactExtras: true,
    propertyDisplayName: "The Grand at Penn",
  });
  assert.match(r.body, /^The Grand at Penn — maintenance\n\nRef #/);
  assert.match(r.body, new RegExp(SMS_COMPLIANCE_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(r.meta.propertyHeader, true);
  assert.equal(r.meta.smsComplianceFooter, true);
  assert.equal(r.parseMode, null);
});

test("renderForChannel — SMS repeat contact same day skips extras", () => {
  const r = renderForChannel({
    transportChannel: "sms",
    body: "Ref #PENN-002 — we're on it.",
    audience: "tenant",
    includeFirstContactExtras: false,
    propertyDisplayName: "The Grand at Penn",
  });
  assert.doesNotMatch(r.body, /Reply STOP/i);
  assert.doesNotMatch(r.body, /The Grand at Penn — maintenance/);
});

test("renderForChannel — staff audience unchanged", () => {
  const r = renderForChannel({
    transportChannel: "sms",
    body: "Staff ping",
    audience: "staff",
    includeFirstContactExtras: true,
    propertyDisplayName: "The Grand at Penn",
  });
  assert.equal(r.body, "Staff ping");
});

test("renderForChannel — Telegram Markdown on Ref and emergency", () => {
  const body =
    "We're treating this as an emergency.\nRef #PENN-001 — heat reported for unit 410.";
  const r = renderForChannel({
    transportChannel: "telegram",
    body,
    audience: "tenant",
    includeFirstContactExtras: false,
  });
  assert.equal(r.parseMode, "Markdown");
  assert.match(r.body, /\*We're treating this as an emergency\.\*/);
  assert.match(r.body, /\*Ref #PENN-001 — heat reported for unit 410\.\*/);
});

test("applyTelegramMarkdown — bolds each Ref line", () => {
  const md = applyTelegramMarkdown("Ref #A\nRef #B");
  assert.match(md, /\*Ref #A\*/);
  assert.match(md, /\*Ref #B\*/);
});
