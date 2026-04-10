/**
 * Normalize inbound phone toward E.164 (+1 US when plausible).
 * GAS uses normalizePhone_; this is a small compatible subset for V2.
 */
function normalizePhoneE164(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  let d = s.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  if (s.startsWith("+")) return "+" + d.replace(/^\+?/, "");
  return s.startsWith("+") ? s : "+" + d;
}

module.exports = { normalizePhoneE164 };
