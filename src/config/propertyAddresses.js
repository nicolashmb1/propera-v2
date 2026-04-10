/**
 * GAS `PROPERTY_ADDRESSES` global — street numbers that must not be mistaken for unit numbers.
 * Populate via env JSON (same shape as GAS: `{ num, hints: [], suffixes: [] }[]`).
 * Empty array = same as GAS when config missing.
 */
function getPropertyAddresses() {
  const raw = process.env.PROPERTY_ADDRESSES_JSON;
  if (!raw || !String(raw).trim()) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

module.exports = { getPropertyAddresses };
