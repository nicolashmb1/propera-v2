"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildInboundKey,
  nosidDigest,
} = require("../src/dal/inboundDedup");

test("buildInboundKey uses SID when MessageSid present", () => {
  const { key, channel } = buildInboundKey({
    messageSid: "SM123",
    from: "+15551234567",
    body: "hello",
  });
  assert.equal(channel, "SMS");
  assert.equal(key, "SID:SMS:SM123");
});

test("buildInboundKey WA channel when From is whatsapp:", () => {
  const { key, channel } = buildInboundKey({
    messageSid: "SM999",
    from: "whatsapp:+15551234567",
    body: "hi",
  });
  assert.equal(channel, "WA");
  assert.equal(key, "SID:WA:SM999");
});

test("buildInboundKey NOSID digest stable", () => {
  const d = nosidDigest("+1x", "body");
  assert.match(d, /^NOSID:[a-f0-9]{32}$/);
  assert.equal(nosidDigest("+1x", "body"), d);
  assert.notEqual(nosidDigest("+1x", "body2"), d);
});

test("buildInboundKey falls back to NOSID when no MessageSid", () => {
  const { key, channel } = buildInboundKey({
    messageSid: "",
    from: "+15550001111",
    body: "  leak  ",
  });
  assert.equal(channel, "SMS");
  assert.ok(key.startsWith("SID:SMS:NOSID:"));
});
