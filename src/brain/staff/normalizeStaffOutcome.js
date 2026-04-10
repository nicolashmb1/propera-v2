/**
 * @see 25_STAFF_RESOLVER.gs — lifecycleNormalizeStaffOutcome_, lifecycleParsePartsEta_
 */

function parsePartsEta(bodyTrim) {
  const out = { partsEtaAt: null, partsEtaText: "" };
  const t = String(bodyTrim || "").trim();
  if (!t) return out;
  const lower = t.toLowerCase();
  const now = new Date();
  const year = now.getFullYear();

  if (/\btomorrow\b/.test(lower)) {
    const d1 = new Date(now);
    d1.setDate(d1.getDate() + 1);
    out.partsEtaAt = d1;
    out.partsEtaText = "tomorrow";
    return out;
  }
  if (/\bnext week\b/.test(lower)) {
    const d2 = new Date(now);
    d2.setDate(d2.getDate() + 7);
    out.partsEtaAt = d2;
    out.partsEtaText = "next week";
    return out;
  }
  const inDays = t.match(/\bin\s+(\d+)\s+days?\b/i);
  if (inDays && inDays[1]) {
    const n = parseInt(inDays[1], 10);
    if (isFinite(n) && n >= 0 && n <= 365) {
      const d3 = new Date(now);
      d3.setDate(d3.getDate() + n);
      out.partsEtaAt = d3;
      out.partsEtaText = "in " + n + " days";
      return out;
    }
  }
  return out;
}

/**
 * @returns {string | { outcome: string, partsEtaAt?: Date, partsEtaText?: string }}
 */
function normalizeStaffOutcome(bodyTrim) {
  const t = String(bodyTrim || "")
    .toLowerCase()
    .trim();
  if (!t) return "UNRESOLVED";
  if (/\b(done|complete|completed|finished|fixed|resolved)\b/.test(t)) return "COMPLETED";
  if (/\b(in progress|working on it|started|on it)\b/.test(t)) return "IN_PROGRESS";
  if (/\b(waiting on parts|parts ordered|waiting for parts|backorder)\b/.test(t)) {
    const eta = parsePartsEta(bodyTrim);
    return { outcome: "WAITING_PARTS", partsEtaAt: eta.partsEtaAt, partsEtaText: eta.partsEtaText };
  }
  if (/\b(vendor|contractor|need to send|dispatch)\b/.test(t)) return "NEEDS_VENDOR";
  if (/\b(delayed|running late|reschedule|tomorrow|next week)\b/.test(t)) return "DELAYED";
  if (/\b(access|key|entry|no access|couldn't get in)\b/.test(t)) return "ACCESS_ISSUE";
  return "UNRESOLVED";
}

module.exports = { normalizeStaffOutcome, parsePartsEta };
