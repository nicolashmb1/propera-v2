"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isSameOrNewConfirmationOnly,
  stripSameOrNewConfirmation,
  resolveAppendHandoffContent,
} = require("../../src/adapters/tenantAgent/resolveAppendHandoffContent");

test("isSameOrNewConfirmationOnly — short confirms", () => {
  assert.equal(isSameOrNewConfirmationOnly("yep same"), true);
  assert.equal(isSameOrNewConfirmationOnly("yes same issue"), true);
  assert.equal(isSameOrNewConfirmationOnly("same one"), true);
  assert.equal(isSameOrNewConfirmationOnly("still leaking badly"), false);
});

test("stripSameOrNewConfirmation — keeps substantive tail", () => {
  assert.equal(stripSameOrNewConfirmation("yep same still leaking worse"), "still leaking worse");
  assert.equal(stripSameOrNewConfirmation("yes same issue"), "");
});

test("resolveAppendHandoffContent — pending body wins over confirm phrase", () => {
  const r = resolveAppendHandoffContent({
    pending: { bodyText: "still leaking badly", mediaJson: "" },
    confirmBodyText: "yep same",
    confirmMediaJson: "",
  });
  assert.equal(r.message, "still leaking badly");
});

test("resolveAppendHandoffContent — photo-only confirm does not send yep same", () => {
  const media = JSON.stringify([{ url: "https://cdn.example.com/leak.jpg" }]);
  const r = resolveAppendHandoffContent({
    pending: { bodyText: "", mediaJson: media },
    confirmBodyText: "same one",
    confirmMediaJson: "",
  });
  assert.equal(r.message, "");
  assert.equal(r.mediaJson, media);
});

test("resolveAppendHandoffContent — merges extra detail from confirm reply", () => {
  const r = resolveAppendHandoffContent({
    pending: { bodyText: "still leaking", mediaJson: "" },
    confirmBodyText: "yes same and getting worse",
    confirmMediaJson: "",
  });
  assert.match(r.message, /still leaking/i);
  assert.match(r.message, /getting worse/i);
});
