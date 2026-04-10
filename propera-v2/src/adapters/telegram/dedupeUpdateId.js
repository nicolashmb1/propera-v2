/**
 * Best-effort dedupe by update_id (single-process). GAS uses TelegramAccepted sheet + lock.
 * For Cloud Run multi-instance, replace with Redis/DB — not business logic, transport hygiene.
 */

const MAX_IDS = 8000;
const seen = new Set();

/**
 * @param {number | string | null | undefined} updateId
 * @returns {boolean} true if this id is new and should be processed; false if duplicate
 */
function tryConsumeUpdateId(updateId) {
  if (updateId == null) return true;
  const key = String(updateId);
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > MAX_IDS) seen.clear();
  return true;
}

module.exports = { tryConsumeUpdateId };
