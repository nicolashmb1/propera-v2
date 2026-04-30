/**
 * Pure contact-window math — GAS `lifecycleIsInsideContactWindow_` / `lifecycleSnapToContactWindow_`.
 * Policy numbers match `property_policy` CONTACT_* keys (loaded elsewhere).
 */

/**
 * @param {object} policy
 * @param {number} policy.earliest
 * @param {number} policy.latest
 * @param {boolean} policy.satAllowed
 * @param {number} policy.satLatest
 * @param {boolean} policy.sunAllowed
 */
function isInsideContactWindow(date, policy) {
  if (!(date instanceof Date) || !isFinite(date.getTime())) return false;
  const earliest = isFinite(policy.earliest) ? policy.earliest : 9;
  const latest = isFinite(policy.latest) ? policy.latest : 18;
  const satLatest = isFinite(policy.satLatest) ? policy.satLatest : 13;
  const satAllowed = !!policy.satAllowed;
  const sunAllowed = !!policy.sunAllowed;

  const d = date.getDay();
  if (d === 0 && !sunAllowed) return false;
  if (d === 6 && !satAllowed) return false;

  const hour =
    date.getHours() +
    date.getMinutes() / 60 +
    date.getSeconds() / 3600;
  const latestHour = d === 6 ? satLatest : latest;
  return hour >= earliest && hour <= latestHour;
}

/**
 * @param {Date} desiredAt
 * @param {object} policy — same shape as `isInsideContactWindow`
 * @returns {Date}
 */
function snapToContactWindow(desiredAt, policy) {
  const d = desiredAt instanceof Date ? desiredAt : new Date(desiredAt);
  if (!isFinite(d.getTime())) return d;

  const earliest = isFinite(policy.earliest) ? policy.earliest : 9;
  const latest = isFinite(policy.latest) ? policy.latest : 18;
  const satLatest = isFinite(policy.satLatest) ? policy.satLatest : 13;
  const satAllowed = !!policy.satAllowed;
  const sunAllowed = !!policy.sunAllowed;

  function dayAllowed(day) {
    if (day === 0) return sunAllowed;
    if (day === 6) return satAllowed;
    return true;
  }

  function latestHourForDay(day) {
    if (day === 6 && satAllowed) return satLatest;
    if (day === 0 && sunAllowed) return latest;
    if (day >= 1 && day <= 5) return latest;
    return -1;
  }

  if (isInsideContactWindow(d, policy)) return d;

  const hour =
    d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  const day = d.getDay();
  const lat = latestHourForDay(day);

  if (dayAllowed(day) && lat >= 0 && hour < earliest) {
    const out = new Date(d);
    out.setHours(Math.floor(earliest), 0, 0, 0);
    return out;
  }

  const next = new Date(d);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + 1);
  for (let i = 0; i < 8; i++) {
    const nd = next.getDay();
    if (dayAllowed(nd)) {
      next.setHours(Math.floor(earliest), 0, 0, 0);
      return next;
    }
    next.setDate(next.getDate() + 1);
  }
  next.setHours(Math.floor(earliest), 0, 0, 0);
  return next;
}

module.exports = {
  isInsideContactWindow,
  snapToContactWindow,
};
