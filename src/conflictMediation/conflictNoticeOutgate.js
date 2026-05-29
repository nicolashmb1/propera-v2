/**
 * CME-2 — neutral, policy-grounded courtesy notice copy (Outgate expression layer).
 * Does not decide tier or policy; receives validated policy + case context only.
 * @see docs/CONFLICT_MEDIATION_ENGINE.md
 */

/**
 * @param {object} o
 * @param {string} [o.propertyLabel] — display name
 * @param {string} [o.subjectUnit]
 * @param {string} [o.policyTitle]
 * @param {string} [o.enforceableText]
 * @param {string} [o.noticeTier] — CME-2: COURTESY only
 */
function buildConflictCourtesyNotice(o) {
  const propertyLabel = String(o.propertyLabel || o.propertyCode || "your building").trim();
  const unit = String(o.subjectUnit || "").trim();
  const policyTitle = String(o.policyTitle || "Building policy").trim();
  const enforceableText = String(o.enforceableText || "").trim();
  const tier = String(o.noticeTier || "COURTESY").trim().toUpperCase();

  const unitLine = unit ? `Unit ${unit}` : "Your unit";
  const tierLabel = tier === "COURTESY" ? "Courtesy notice" : `${tier} notice`;

  const lines = [
    `${propertyLabel} — ${tierLabel}`,
    "",
    `${unitLine}:`,
    "",
    policyTitle,
  ];
  if (enforceableText) {
    lines.push("", enforceableText);
  }
  lines.push(
    "",
    "This is an official building policy reminder from management. Please bring your unit into compliance.",
    "",
    "Reply to this message or contact the office if you have questions."
  );

  return lines.join("\n").trim();
}

module.exports = {
  buildConflictCourtesyNotice,
};
