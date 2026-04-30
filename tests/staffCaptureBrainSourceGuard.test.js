/**
 * Regression guard: staff draft ownership must not be recomputed from transport in core.
 * Reads source text — fails if forbidden patterns reappear.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const CORE = path.join(__dirname, "../src/brain/core/handleInboundCore.js");

test("handleInboundCore — no removed DAL resolver for draft owner", () => {
  const src = fs.readFileSync(CORE, "utf8");
  assert.ok(
    !/getCanonicalStaffDraftOwnerKey/.test(src),
    "getCanonicalStaffDraftOwnerKey must not return to core"
  );
});

test("handleInboundCore — staff capture draft owner uses explicit canonical only", () => {
  const src = fs.readFileSync(CORE, "utf8");
  assert.match(
    src,
    /const draftOwnerKey = isStaffCapture \? explicitCanonical/s,
    "draftOwnerKey must be explicitCanonical when isStaffCapture"
  );
});
