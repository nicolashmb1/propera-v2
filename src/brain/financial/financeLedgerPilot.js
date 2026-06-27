/** Properties on Propera-owned ledger path (delta mimic, opening balance, drift flags). */

const FINANCE_LEDGER_PILOT_PROPERTIES = new Set(["WESTFIELD", "PENN"]);

function isFinanceLedgerPilotProperty(propertyCode) {
  const code = String(propertyCode ?? "").trim().toUpperCase();
  return FINANCE_LEDGER_PILOT_PROPERTIES.has(code);
}

module.exports = {
  FINANCE_LEDGER_PILOT_PROPERTIES,
  isFinanceLedgerPilotProperty,
  /** @deprecated use FINANCE_LEDGER_PILOT_PROPERTIES */
  PROPERA_LEDGER_OPENING_PROPERTIES: FINANCE_LEDGER_PILOT_PROPERTIES,
  /** @deprecated use FINANCE_LEDGER_PILOT_PROPERTIES */
  PROPERA_OCCUPANCY_DRIFT_PROPERTIES: FINANCE_LEDGER_PILOT_PROPERTIES,
};
