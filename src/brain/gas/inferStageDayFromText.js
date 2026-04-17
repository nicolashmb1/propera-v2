/**
 * Port of GAS `inferStageDayFromText_` — `17_PROPERTY_SCHEDULE_ENGINE.gs` ~2387–2398.
 *
 * @param {string|null|undefined} text
 * @param {string|null|undefined} fallbackDayWord
 * @returns {"Today"|"Tomorrow"}
 */
function inferStageDayFromText_(text, fallbackDayWord) {
  const s = String(text || "").toLowerCase();

  if (/\b(tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr)\b/.test(s)) return "Tomorrow";
  if (/\btoday\b/.test(s)) return "Today";

  const fb = String(fallbackDayWord || "").toLowerCase();
  if (/tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr/.test(fb)) return "Tomorrow";
  return "Today";
}

module.exports = { inferStageDayFromText_ };
