/**
 * Staff #capture tenant name hints + roster pick rules (GAS 14 / 16).
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractStaffTenantNameHintCombined,
  extractLeadingStaffTenantNameHint_,
  scoreNameMatch_,
} = require("../src/brain/gas/extractStaffTenantNameHintFromText");
const {
  pickResolvedTenantPhone,
} = require("../src/dal/tenantRoster");

describe("extractStaffTenantNameHint (GAS 16 + leading)", () => {
  test("leading: Maria report from 101 westfield", () => {
    const t = "Maria  report from 101 westfield that her sink is leaking";
    assert.equal(extractLeadingStaffTenantNameHint_(t), "Maria");
    assert.equal(extractStaffTenantNameHintCombined(t), "Maria");
  });

  test("tail: issue text. Ana", () => {
    const t = "Sink leaking in kitchen. Ana";
    assert.equal(extractStaffTenantNameHintCombined(t), "Ana");
  });

  test("scoreNameMatch exact", () => {
    assert.equal(scoreNameMatch_("maria", "Maria"), 100);
  });

  test("scoreNameMatch prefix 85", () => {
    assert.equal(scoreNameMatch_("john", "Johnathan"), 85);
  });
});

describe("pickResolvedTenantPhone (GAS enrich rules)", () => {
  test("with hint: single score >= 85 → MATCHED", () => {
    const r = pickResolvedTenantPhone(
      [{ phone: "+15551234567", name: "Maria L", score: 100 }],
      "Maria"
    );
    assert.equal(r.phoneE164, "+15551234567");
    assert.equal(r.status, "MATCHED");
  });

  test("with hint: no candidates → NO_MATCH", () => {
    const r = pickResolvedTenantPhone([], "John");
    assert.equal(r.phoneE164, "");
    assert.equal(r.status, "NO_MATCH");
  });

  test("with hint: two candidates → AMBIGUOUS", () => {
    const r = pickResolvedTenantPhone(
      [
        { phone: "+1a", name: "A", score: 100 },
        { phone: "+1b", name: "B", score: 100 },
      ],
      "x"
    );
    assert.equal(r.status, "AMBIGUOUS");
  });

  test("with hint: score 70 → SKIPPED_LOW_CONFIDENCE", () => {
    const r = pickResolvedTenantPhone(
      [{ phone: "+15551234567", name: "Jonathan", score: 70 }],
      "john"
    );
    assert.equal(r.phoneE164, "");
    assert.equal(r.status, "SKIPPED_LOW_CONFIDENCE");
  });

  test("no hint: exactly one occupant → MATCHED", () => {
    const r = pickResolvedTenantPhone(
      [{ phone: "+15551234567", name: "Anyone", score: 100 }],
      ""
    );
    assert.equal(r.phoneE164, "+15551234567");
    assert.equal(r.status, "MATCHED");
  });

  test("no hint: two occupants → AMBIGUOUS", () => {
    const r = pickResolvedTenantPhone(
      [
        { phone: "+1a", name: "A", score: 100 },
        { phone: "+1b", name: "B", score: 100 },
      ],
      ""
    );
    assert.equal(r.status, "AMBIGUOUS");
  });
});
