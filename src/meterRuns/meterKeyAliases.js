/**
 * Expand vision/QR meter strings toward DB `utility_meters.meter_key` shape (MTR_{PROPERTY}_{UNIT}_{UTIL}).
 * @see meterBillingRuns.matchMeterForProperty
 */

function normProp(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function normMeterKey(key) {
  return String(key || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
}

/**
 * @param {string} raw
 * @param {string} propertyCode
 * @returns {string[]} unique normalized keys (original + aliases)
 */
function expandMeterKeyAliases(raw, propertyCode) {
  const pc = normProp(propertyCode);
  const k0 = normMeterKey(raw);
  if (!k0) return [];

  const out = [];
  const add = (x) => {
    const t = normMeterKey(x);
    if (t && !out.includes(t)) out.push(t);
  };

  add(k0);

  // Common QR typo
  if (k0.includes("WESTGRAD") && !k0.includes("WESTGRAND")) {
    add(k0.replace(/WESTGRAD/g, "WESTGRAND"));
  }

  // WESTGRAND_402_WATER → MTR_WESTGRAND_402_WATER
  if (pc && k0.startsWith(`${pc}_`) && !k0.startsWith("MTR_")) {
    add(`MTR_${k0}`);
  }

  // Sticker shorthand MTR_WG203_WATER → MTR_WESTGRAND_203_WATER (Grand West only)
  const mtrWg = k0.match(/^MTR_WG(\d{2,4})_(.+)$/);
  if (mtrWg && pc === "WESTGRAND") {
    const n = String(parseInt(mtrWg[1], 10));
    add(`MTR_WESTGRAND_${n}_${mtrWg[2]}`);
  }

  // Human label WG 402 WATER → WG_402_WATER → MTR_WESTGRAND_402_WATER
  const wg = k0.match(/^WG_(\d{2,4})_(.+)$/);
  if (wg && pc) {
    const n = String(parseInt(wg[1], 10));
    add(`MTR_${pc}_${n}_${wg[2]}`);
  }

  return out;
}

/**
 * Prefer keys that look like full QR ids (MTR_… with enough segments).
 * @param {string[]} sources
 */
function sortMeterKeySources(sources) {
  const score = (s) => {
    const k = normMeterKey(s);
    if (!k) return 99;
    if (k.startsWith("MTR_") && (k.match(/_/g) || []).length >= 3) return 0;
    if (k.startsWith("MTR_")) return 1;
    return 2;
  };
  return [...sources].sort((a, b) => score(a) - score(b));
}

/**
 * @param {string} propertyCode
 * @param {object} extraction
 * @param {string|null|undefined} qrDecodedHint
 * @returns {string[]} ordered unique candidates
 */
function buildMeterKeyCandidates(propertyCode, extraction, qrDecodedHint) {
  const ex = extraction && typeof extraction === "object" ? extraction : {};
  const rawSources = [qrDecodedHint, ex.qrValue, ex.meterLabel].filter((x) => x != null && String(x).trim());
  const sources = sortMeterKeySources(rawSources.map((x) => String(x).trim()));

  const candidates = [];
  for (const s of sources) {
    for (const c of expandMeterKeyAliases(s, propertyCode)) {
      if (!candidates.includes(c)) candidates.push(c);
    }
  }
  return candidates;
}

/**
 * Partial match only when exactly one meter qualifies (avoids MTR_WESTGRAND_WATER → arbitrary unit).
 * @param {{ meter_key: string }[]} meters
 * @param {string} key normalized
 */
function findUniquePartialMeter(meters, key) {
  const nk = normMeterKey(key);
  if (!nk) return null;
  const hits = meters.filter((m) => {
    const mk = normMeterKey(m.meter_key);
    return nk.includes(mk) || mk.includes(nk);
  });
  if (hits.length === 1) return hits[0];
  return null;
}

module.exports = {
  normProp,
  normMeterKey,
  expandMeterKeyAliases,
  buildMeterKeyCandidates,
  findUniquePartialMeter,
};
