/**
 * Manager / vendor routing policy — env-driven (same knobs as GAS script properties).
 * @see 14_DIRECTORY_SESSION_DAL.gs — isManager_, isVendor_
 */
const { env } = require("./env");

function digitsLast10(s) {
  return String(s || "")
    .replace(/\D/g, "")
    .slice(-10);
}

function managerTelegramDigitsSet() {
  const raw = env("MANAGER_TELEGRAM_IDS", env("MANAGER_TG_IDS", ""));
  const set = new Set();
  raw
    .split(",")
    .map((x) => String(x || "").replace(/^TG:\s*/i, "").replace(/\D/g, ""))
    .filter(Boolean)
    .forEach((d) => set.add(d));
  return set;
}

function managerPhoneLast10Set() {
  const set = new Set();
  const single = env("MANAGER_PHONE", env("ONCALL_NUMBER", ""));
  const csv = env("MANAGER_PHONES", "");
  [single, ...csv.split(",")]
    .map((s) => digitsLast10(s))
    .filter(Boolean)
    .forEach((d) => set.add(d));
  return set;
}

/** Optional: comma-separated last-10 digits for known vendor phones (until vendors table exists). */
function vendorPhoneLast10Set() {
  const set = new Set();
  env("VENDOR_PHONE_LAST10_LIST", "")
    .split(",")
    .map((s) => digitsLast10(s))
    .filter(Boolean)
    .forEach((d) => set.add(d));
  return set;
}

function isManagerActorKey(actorKey) {
  const raw = String(actorKey || "").trim();
  if (!raw) return false;
  if (/^TG:/i.test(raw)) {
    const d = raw.replace(/^TG:\s*/i, "").replace(/\D/g, "");
    return d && managerTelegramDigitsSet().has(d);
  }
  const d10 = digitsLast10(raw);
  return d10 && managerPhoneLast10Set().has(d10);
}

function isVendorActorKey(actorKey) {
  const d10 = digitsLast10(actorKey);
  if (d10 && vendorPhoneLast10Set().has(d10)) return true;
  return false;
}

module.exports = {
  isManagerActorKey,
  isVendorActorKey,
  managerTelegramDigitsSet,
  managerPhoneLast10Set,
};
