/**
 * Deterministic tenant finalize receipt — see docs/OUTGATE_VOICE_SPEC.md (Phase 1).
 */

const { deriveIssuePhrase } = require("./deriveIssuePhrase");

/**
 * @typedef {"routine"|"urgent"|"emergency"} ReceiptTier
 */

/**
 * @param {ReceiptTier} tier
 * @param {boolean} multi
 * @returns {string}
 */
function maintenanceReceiptTemplateKey(tier, multi) {
  if (multi) return "MAINTENANCE_RECEIPT_MULTI";
  if (tier === "emergency") return "MAINTENANCE_RECEIPT_EMERGENCY";
  if (tier === "urgent") return "MAINTENANCE_RECEIPT_URGENT";
  return "MAINTENANCE_RECEIPT_ROUTINE";
}

/**
 * @param {string} [displayName]
 * @param {string} [propertyCode]
 * @returns {string}
 */
function formatPropertyAtLabel(displayName, propertyCode) {
  const display = String(displayName || "").trim();
  if (display) return display;
  const code = String(propertyCode || "").trim();
  if (!code) return "the building";
  return code.charAt(0).toUpperCase() + code.slice(1).toLowerCase();
}

/**
 * @param {{ commonArea?: boolean, unitLabel?: string, locationLabelSnapshot?: string, propertyDisplayName?: string, propertyCode?: string }} loc
 * @param {"confirm"|"report"|"short"} mode
 */
function formatLocationFragment(loc, mode) {
  const commonArea = !!loc.commonArea;
  if (commonArea) {
    const propertyAt = formatPropertyAtLabel(loc.propertyDisplayName, loc.propertyCode);
    if (mode === "short") return propertyAt;
    return propertyAt;
  }
  const unit = String(loc.unitLabel || "").trim();
  if (!unit) return mode === "short" ? "your unit" : "your unit";
  return mode === "short" ? `unit ${unit}` : `unit ${unit}`;
}

/**
 * @param {string} phrase
 */
function phraseForSentence(phrase) {
  const p = String(phrase || "").trim();
  if (!p) return "Maintenance issue";
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * @param {object} o
 * @param {string} o.ticketId
 * @param {string} o.issuePhrase
 * @param {ReceiptTier} o.tier
 * @param {boolean} o.commonArea
 * @param {string} [o.unitLabel]
 * @param {string} [o.locationLabelSnapshot]
 * @param {string} [o.propertyDisplayName]
 * @param {string} [o.propertyCode]
 * @param {string} [o.emergencyType]
 * @returns {string}
 */
function buildSingleMaintenanceReceipt(o) {
  const loc = {
    commonArea: o.commonArea,
    unitLabel: o.unitLabel,
    locationLabelSnapshot: o.locationLabelSnapshot,
    propertyDisplayName: o.propertyDisplayName,
    propertyCode: o.propertyCode,
  };
  const issue = phraseForSentence(o.issuePhrase);
  const where = formatLocationFragment(loc, "confirm");
  const ref = String(o.ticketId || "").trim();
  const propertyAt = formatPropertyAtLabel(o.propertyDisplayName, o.propertyCode);

  if (o.tier === "emergency") {
    const reportedWhere = o.commonArea
      ? `at ${propertyAt}`
      : `for ${where}`;
    const gasNote =
      String(o.emergencyType || "").toUpperCase().includes("GAS")
        ? " If the smell gets stronger, leave your apartment and call 911."
        : "";
    return [
      "We're treating this as an emergency.",
      `Ref #${ref} — ${issue.toLowerCase()} reported ${reportedWhere}. Someone is being contacted now.${gasNote}`,
      "Please stay safe.",
    ].join("\n");
  }

  if (o.tier === "urgent") {
    const urgentWhere = o.commonArea
      ? `at ${propertyAt}`
      : `for ${where}`;
    return [
      `Ref #${ref} — we're on it.`,
      `Noted — we're prioritizing the ${issue.toLowerCase()} ${urgentWhere}.`,
      "Someone will be there as soon as possible.",
    ].join("\n");
  }

  const confirmLine = o.commonArea
    ? `${issue} confirmed at ${propertyAt}.`
    : `${issue} confirmed for ${where}.`;

  return [
    `Ref #${ref} — we're on it.`,
    confirmLine,
    "We'll be in touch shortly.",
  ].join("\n");
}

/**
 * @param {object} o
 * @param {Array<{ ticketId: string, issueText?: string, urgency?: string }>} o.fins
 * @param {Array<{ issueText?: string, urgency?: string }>} [o.groups]
 * @param {boolean} [o.emergency]
 * @param {boolean} [o.commonArea]
 * @param {string} [o.unitLabel]
 * @param {string} [o.locationLabelSnapshot]
 * @param {string} [o.propertyDisplayName]
 * @param {string} [o.propertyCode]
 * @returns {{ body: string, templateKey: string, tier: ReceiptTier }}
 */
function buildMaintenanceReceipt(o) {
  const fins = Array.isArray(o.fins) ? o.fins : [];
  const groups = Array.isArray(o.groups) ? o.groups : [];
  const emergency = !!o.emergency;
  const loc = {
    commonArea: !!o.commonArea,
    unitLabel: o.unitLabel,
    locationLabelSnapshot: o.locationLabelSnapshot,
    propertyDisplayName: o.propertyDisplayName,
    propertyCode: o.propertyCode,
  };
  const whereShort = formatLocationFragment(loc, "short");

  const items = fins.map((fin, i) => {
    const g = groups[i] || {};
    const issueText = String(g.issueText || fin.issueText || "").trim();
    return {
      ticketId: String(fin.ticketId || "").trim(),
      issuePhrase: deriveIssuePhrase(issueText),
      urgency: String(g.urgency || fin.urgency || "Normal"),
    };
  });

  if (items.length === 0) {
    return {
      body: "Ref # — we're on it.\nWe'll be in touch shortly.",
      templateKey: maintenanceReceiptTemplateKey("routine", false),
      tier: "routine",
    };
  }

  if (items.length > 1) {
    const lines = items.map((item) => {
      const phrase = phraseForSentence(item.issuePhrase);
      if (loc.commonArea) {
        return `Ref #${item.ticketId} — ${phrase} at ${whereShort}.`;
      }
      return `Ref #${item.ticketId} — ${phrase}, ${whereShort}.`;
    });
    const closing =
      items.length === 2
        ? "Both are being handled. We'll be in touch shortly."
        : "All are being handled. We'll be in touch shortly.";
    if (emergency) {
      lines.unshift("We're treating this as an emergency.");
      lines.push("Please stay safe.");
    } else {
      lines.push(closing);
    }
    const tier = emergency ? "emergency" : "routine";
    return {
      body: lines.join("\n"),
      templateKey: maintenanceReceiptTemplateKey(tier, true),
      tier,
    };
  }

  const one = items[0];
  let tier = "routine";
  if (emergency) tier = "emergency";
  else if (String(one.urgency || "").toLowerCase() === "urgent") tier = "urgent";

  return {
    body: buildSingleMaintenanceReceipt({
      ticketId: one.ticketId,
      issuePhrase: one.issuePhrase,
      tier,
      emergencyType: String(one.emergencyType || o.emergencyType || "").trim(),
      ...loc,
    }),
    templateKey: maintenanceReceiptTemplateKey(tier, false),
    tier,
  };
}

module.exports = {
  buildMaintenanceReceipt,
  buildSingleMaintenanceReceipt,
  maintenanceReceiptTemplateKey,
  formatPropertyAtLabel,
};
