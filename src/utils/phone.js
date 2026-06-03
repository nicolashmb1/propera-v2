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

/** E.164 values to try when matching tenant_roster (legacy +10-digit saves). */
function rosterPhoneLookupCandidates(phoneRaw) {
  const out = new Set();
  const canonical = normalizePhoneE164(phoneRaw);
  if (canonical) out.add(canonical);

  const digits = String(phoneRaw || "").replace(/\D/g, "");
  if (digits.length === 10) {
    out.add("+1" + digits);
    out.add("+" + digits);
  } else if (digits.length === 11 && digits.startsWith("1")) {
    const ten = digits.slice(1);
    out.add("+" + digits);
    out.add("+1" + ten);
    out.add("+" + ten);
  }

  return [...out];
}

module.exports = { normalizePhoneE164, rosterPhoneLookupCandidates };
