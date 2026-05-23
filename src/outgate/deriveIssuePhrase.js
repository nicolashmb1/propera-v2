/**
 * Short cleaned issue phrase for tenant receipts (English canonical — localize in Phase 5).
 */

/** @param {string} issueText */
function deriveIssuePhrase(issueText) {
  const raw = String(issueText || "").trim();
  if (!raw) return "maintenance issue";

  const t = raw.toLowerCase();

  if (/\b(on fire|kitchen is on fire|fire)\b/.test(t)) return "fire";
  if (/\b(no heat|not heating|heat(ing)?\s+(not working|broken|out)|heat broke)\b/.test(t)) {
    return "heat not working";
  }
  if (/\bheat\b/.test(t)) return "heat issue";
  if (/\bsink\b/.test(t) && /\bleak/.test(t)) return "kitchen sink leak";
  if (/\bleak/.test(t)) return "leak";
  if (/\bice maker\b|\bicemaker\b/.test(t) && /\b(not working|broken|won't)\b/.test(t)) {
    return "ice maker not working";
  }
  if (/\bac\b|\ba\/c\b/.test(t) && /\b(not|doesn't|won't|no)\b/.test(t)) {
    return "AC not working";
  }
  if (/\blight\b/.test(t) && /\b(broken|out|not working)\b/.test(t)) return "broken light";
  if (/\block\b|\blocked\b/.test(t)) return "lock issue";
  if (/\bclog\b|\bclogged\b/.test(t)) return "clog";

  let cleaned = raw
    .replace(/^(yo|hi|hey|hello)\b[\s,!]*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > 55) cleaned = cleaned.slice(0, 52).trim() + "…";
  if (!cleaned) return "maintenance issue";
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

module.exports = { deriveIssuePhrase };
