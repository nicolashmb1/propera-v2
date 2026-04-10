/**
 * Sheet1 Category column + helpers — ported from GAS `localCategoryFromText_`
 * @see 18_MESSAGING_ENGINE.gs ~644–702 (order of checks matters)
 */
const crypto = require("crypto");

/**
 * GAS-style display id e.g. MURR-031626-0244 (prefix + MMDDYY + random 4 digits).
 */
function formatHumanTicketId(ticketPrefix) {
  const prefix = String(ticketPrefix || "TKT").toUpperCase().replace(/[^A-Z0-9]/g, "") || "TKT";
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}-${mm}${dd}${yy}-${rand}`;
}

// PARITY GAP: not full GAS emergency keyword set — see docs/PARITY_LEDGER.md §4
function inferEmergency(issueText) {
  const t = String(issueText || "").toLowerCase();
  if (
    /\b(flood(ing)?|gas\s*leak|fire\b|no heat|electrical hazard|911|emergency)\b/.test(
      t
    )
  ) {
    return { emergency: "Yes", emergencyType: "" };
  }
  return { emergency: "No", emergencyType: "" };
}

/**
 * Same keyword order as GAS `localCategoryFromText_` (18_MESSAGING_ENGINE.gs).
 * Allowed labels: Appliance, Cleaning, Electrical, General, HVAC, Lock/Key,
 * Plumbing, Paint/Repair, Pest, Safety.
 *
 * **V2 deterministic path:** if no rule matches, returns `"General"` (GAS returns `""`
 * at line 702). Full brain may override with an LLM package category hint later.
 *
 * PARITY GAP: default `"General"` vs GAS `""` — see docs/PARITY_LEDGER.md §4
 */
function localCategoryFromText(message) {
  const t = String(message || "").toLowerCase();

  if (
    /(gas smell|smell gas|carbon monoxide|co alarm|smoke|fire|sparks|arcing|electrical arc|flooding|sewage|backing up|overflowing)/.test(
      t
    )
  ) {
    return "Safety";
  }

  if (
    /(outlet|outlets|no power|power out|lost power|breaker|tripped|panel|electric|electrical|gfci|reset button|flicker|flickering|short|burning smell|switch not working|lights? (out|not working)|receptacle)/.test(
      t
    )
  ) {
    return "Electrical";
  }

  if (/(light|lights|lamp|fixture|bulb|ballast|sconce|cover)/.test(t)) {
    return "Electrical";
  }

  if (
    /(leak|leaking|pipe|faucet|toilet|clog|clogged|drain|sewer|water pressure|no water|hot water|cold water|sink|tub|shower|backed up)/.test(
      t
    )
  ) {
    return "Plumbing";
  }

  if (
    /(washing machine|wash machine|washer|dryer|laundry|dishwasher|fridge|refrigerator|freezer|oven|stove|range|microwave|garbage disposal|disposal)/.test(
      t
    )
  ) {
    return "Appliance";
  }

  if (
    /(heat|heating|no heat|\bac\b|a\/c|air conditioner|air conditioning|no ac|thermostat|boiler|radiator|furnace|\bvent\b|hvac)/.test(
      t
    )
  ) {
    return "HVAC";
  }

  if (
    /(locked out|lockout|lost key|lost keys|key fob|fob|deadbolt|lock broken|lock not working|can.?t get in|cannot get in|door won.?t open)/.test(
      t
    )
  ) {
    return "Lock/Key";
  }

  if (
    /(roach|roaches|mouse|mice|rat|rats|bed bug|bedbug|ant|ants|spider|spiders|wasp|bees|pest)/.test(
      t
    )
  ) {
    return "Pest";
  }

  if (
    /(trash|garbage|dirty|cleanup|clean up|cleaning|spill|odor|smell(?! gas)|stain|mold|mildew)/.test(
      t
    )
  ) {
    return "Cleaning";
  }

  if (
    /(paint|painting|patch|hole in wall|drywall|crack|repair wall|baseboard|trim|cabinet|drawer|hinge|door frame|tile|grout|caulk|blind|curtain|shelf|closet)/.test(
      t
    )
  ) {
    return "Paint/Repair";
  }

  if (/(maintenance|repair|fix|broken|not working|issue|problem)/.test(t)) {
    return "General";
  }

  return "General";
}

function buildThreadIdV2(opts) {
  const trace = String(opts.traceId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12);
  const tg = String(opts.telegramUpdateId || "").trim();
  const chat = String(opts.telegramChatId || "").trim();
  if (opts.mode === "MANAGER") {
    return ["V2", "STAFFCAP", trace || "x", tg || chat || "na"].join(":");
  }
  return ["V2", "TG", trace || "x", tg || "na"].join(":");
}

module.exports = {
  formatHumanTicketId,
  inferEmergency,
  localCategoryFromText,
  /** @deprecated use localCategoryFromText */
  inferCategoryLabel: localCategoryFromText,
  buildThreadIdV2,
};
