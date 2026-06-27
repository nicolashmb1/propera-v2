const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FINANCE_LEDGER_PILOT_PROPERTIES,
  isFinanceLedgerPilotProperty,
} = require("../src/brain/financial/financeLedgerPilot");

test("isFinanceLedgerPilotProperty includes WESTFIELD and PENN", () => {
  assert.equal(isFinanceLedgerPilotProperty("westfield"), true);
  assert.equal(isFinanceLedgerPilotProperty("PENN"), true);
  assert.equal(isFinanceLedgerPilotProperty("MURRAY"), false);
});

test("FINANCE_LEDGER_PILOT_PROPERTIES is shared pilot set", () => {
  assert.deepEqual([...FINANCE_LEDGER_PILOT_PROPERTIES].sort(), ["PENN", "WESTFIELD"]);
});
