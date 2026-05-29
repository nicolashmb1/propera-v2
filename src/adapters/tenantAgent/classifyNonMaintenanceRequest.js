/**
 * Maintenance-only lane — detect requests outside maintenance intake (adapter expression).
 */
const { hasProblemSignal } = require("../../brain/core/splitIssueGroups");

const TRASH_FAQ_RE =
  /\b(garbage\s+truck|trash\s+(day|pickup|schedule|collection)|recycling\s+(day|pickup|schedule)|when\s+does\s+(the\s+)?(garbage|trash|recycling)|where\s+does\s+(the\s+)?(garbage|trash))\b/i;

const LEASING_DOCS_RE =
  /\b(lease(\s+copy|\s+agreement)?|copy\s+of\s+(my\s+)?(lease|invoice|invoices|rent(\s+invoice)?|statement|bill)|invoices?|rent\s+statement|rent\s+invoice|billing|payment\s+history|security\s+deposit|move[\s-]?out\s+inspection|ledger|pay\s+rent|rent\s+balance)\b/i;

const AMENITY_NAMES_RE =
  /\b(pool|gameroom|game\s*room|sauna|terrace|party\s+room|amenit(?:y|ies)|gym|fitness(\s+center|\s+room)?|workout\s+room|laundry(\s+room)?)\b/i;

const AMENITY_RE =
  /\b(reserv(?:e|ation)s?|book(?:ing)?s?|gameroom|game\s*room|sauna|terrace|party\s+room|amenit(?:y|ies)|pool(?:\s+pass)?|gym|fitness(\s+center|\s+room)?|workout\s+room|laundry(\s+room)?)\b/i;

const AMENITY_HOURS_FAQ_RE =
  /\b((what|when)(\s+time|\s+does|\s+is)?|hours?\s+(for|of|at)?).*\b(open|close|closing|hours|until|available)\b/i;

const AMENITY_AVAILABILITY_RE =
  /\b(trying to use|can i use|want to use|use the)\b.*\b(pool|gym|gameroom|game\s*room|fitness|laundry(\s+room)?)\b|\b(pool|gym|gameroom|game\s*room|fitness|laundry(\s+room)?)\b.*\b(available|availability|open|reserv(?:e|ation)s?|book(?:ing)?s?)\b/i;

const BUILDING_INFO_RE =
  /\b(office\s+hours|front\s+desk|parking\s+rules|visitor\s+parking|mail\s+room|package\s+room|where\s+do\s+i\s+(pick\s+up|get))\b/i;

const NON_OPS_RE =
  /\b(i\s+have\s+a\s+)?(headache|stomach\s*ache|feeling\s+sick|just\s+bored)\b/i;

const CLEANING_SCHEDULE_FAQ_RE =
  /\b(when|what day|what time)\b.*\b(clean(?:ing)?|janitor(?:ial)?|maid|housekeep(?:ing)?)\b|\b(clean(?:ing)?|janitor(?:ial)?|maid|housekeep(?:ing)?)\b.*\b(when|what day|what time|schedule|coming)\b/i;

const STAFF_HANDOFF_RE =
  /\b(speak\s+to\s+(a\s+)?(person|human|manager|super|superintendent|office)|not\s+(a\s+)?maintenance|wrong\s+(department|number))\b/i;

/**
 * Pool/gym/amenity availability or booking status — not a repair intake.
 * @param {string} bodyText
 * @returns {boolean}
 */
function isAmenityAvailabilityInquiry(bodyText) {
  const t = String(bodyText || "").trim();
  if (!t) return false;
  if (AMENITY_AVAILABILITY_RE.test(t)) return true;
  if (AMENITY_NAMES_RE.test(t) && /\b(available|availability|reserv(?:e|ation)s?|book(?:ing)?s?)\b/i.test(t)) {
    return true;
  }
  if (
    AMENITY_NAMES_RE.test(t) &&
    /\b(is it|still|yet)\b/i.test(t) &&
    /\b(open|closed|available)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Repair / maintenance symptom — excludes trash-schedule FAQ phrasing.
 * @param {string} bodyText
 * @returns {boolean}
 */
function isMaintenanceRepairRequest(bodyText) {
  const t = String(bodyText || "").trim();
  if (!t) return false;
  if (isAmenityAvailabilityInquiry(t)) return false;
  if (CLEANING_SCHEDULE_FAQ_RE.test(t)) return false;
  if (TRASH_FAQ_RE.test(t)) return false;
  if (LEASING_DOCS_RE.test(t)) return false;
  if (AMENITY_RE.test(t)) return false;
  if (AMENITY_HOURS_FAQ_RE.test(t) && AMENITY_NAMES_RE.test(t)) return false;

  // Explicit "I want maintenance" phrasing — strong, unambiguous signal.
  // The symptom-based regex below misses these because `\bmaintain\b` does
  // not match the word "maintenance". Tenants who reach for the word
  // "maintenance" / "service request" / "work order" want to escape whatever
  // lane they're in; treat it as a high-confidence interrupt.
  if (
    /\b(maintenance|service request|work order|maint request|maint ticket)\b/i.test(t)
  ) {
    return true;
  }

  if (
    /\b(leak|leaking|drip|dripping|sink|faucet|broken|not working|doesn'?t work|won'?t|fix|repair|replace|clog|flood|mold|no heat|no ac|lockout|locked out|smell gas|gas smell|elevator|lift)\b/i.test(
      t
    )
  ) {
    return true;
  }

  if (
    /\b(send|have|get)\b.*\b(someone|maintenance|super|tech)\b.*\b(check|look|fix)\b/i.test(t) ||
    /\b(check|look at)\b.*\b(sink|leak|drip|toilet|cabinet|faucet)\b/i.test(t)
  ) {
    return true;
  }

  if (
    /\b(smell(s|ing)?|stink(s|ing)?|odor|odour|foul|nasty|horrible|bad)\b/i.test(t) &&
    !/\b(when|what day|schedule|time)\b/i.test(t)
  ) {
    return true;
  }

  if (
    /\b(send|need|want|can you|could you|please)\b.*\b(clean|fix|service|maintain)\b/i.test(t) ||
    /\b(clean|fix|service)\b.*\b(elevator|lobby|hallway|stairwell|common area|laundry room|trash room)\b/i.test(
      t
    )
  ) {
    return true;
  }

  return hasProblemSignal(t);
}

/**
 * High-confidence non-maintenance tenant request (lease, amenity, FAQ, abuse).
 * @param {string} bodyText
 * @returns {boolean}
 */
function isNonMaintenanceRequest(bodyText) {
  const t = String(bodyText || "").trim();
  if (!t || t.length > 500) return false;

  if (LEASING_DOCS_RE.test(t)) return true;
  if (isAmenityAvailabilityInquiry(t)) return true;
  if (AMENITY_RE.test(t)) return true;
  if (AMENITY_HOURS_FAQ_RE.test(t) && AMENITY_NAMES_RE.test(t)) return true;
  if (TRASH_FAQ_RE.test(t)) return true;
  if (BUILDING_INFO_RE.test(t)) return true;
  if (NON_OPS_RE.test(t) && !/\b(mold|gas|carbon)\b/i.test(t)) return true;
  if (STAFF_HANDOFF_RE.test(t)) return true;

  if (isMaintenanceRepairRequest(t)) return false;

  if (
    /\?/.test(t) &&
    /\b(lease|document|copy|rent|invoice|billing|statement|gameroom|game\s*room|gym|fitness|pool|laundry|reserv(?:e|ation)s?|garbage|trash|amenit(?:y|ies)|hours|open|close)\b/i.test(
      t
    )
  ) {
    return true;
  }

  if (
    AMENITY_HOURS_FAQ_RE.test(t) &&
    /\b(gym|fitness|pool|laundry|lobby|mail|package|office|front\s+desk|parking)\b/i.test(t)
  ) {
    return true;
  }

  if (/\b(invoice|billing|rent\s+invoice)\b/i.test(t)) return true;

  return false;
}

function isAccessRequest(bodyText) {
  const t = String(bodyText || "").trim();
  if (!t) return false;
  if (isAmenityAvailabilityInquiry(t)) return true;
  if (AMENITY_RE.test(t)) return true;
  if (AMENITY_HOURS_FAQ_RE.test(t) && AMENITY_NAMES_RE.test(t)) return true;
  return false;
}

module.exports = {
  isNonMaintenanceRequest,
  isMaintenanceRepairRequest,
  isAccessRequest,
  isAmenityAvailabilityInquiry,
};
