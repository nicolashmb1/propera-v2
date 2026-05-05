/**
 * Normalize Telegram user ids into staff/contact lookup keys (`TG:<digits>`).
 * @see resolveStaffContext.js — GAS normalizeTelegramActorKeyForStaff_
 */
function normalizeTelegramActorKeyForStaff(raw) {
  const s = String(raw || "").trim();
  if (!/^TG:/i.test(s)) return "";
  const id = s.replace(/^TG:\s*/i, "").replace(/\D/g, "");
  return id ? "TG:" + id : "";
}

module.exports = {
  normalizeTelegramActorKeyForStaff,
};
