/**
 * Sheet1 Category / Emergency columns + helpers — ported from GAS `18_MESSAGING_ENGINE.gs`
 * (`localCategoryFromText_` ~644–702, `hardEmergency_` ~373–522, `evaluateEmergencySignal_` ~530–603,
 * `detectEmergencyKind_` ~1204–1216).
 */
/**
 * GAS-style display id — shape similar to `makeTicketId_` (`14_DIRECTORY_SESSION_DAL.gs` ~845–867):
 * PREFIX-MMDDYY-suffix. GAS suffix is sheet row–based; V2 uses random 4 digits (no Sheet row at create).
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

/**
 * Port of `hardEmergency_` — `18_MESSAGING_ENGINE.gs` ~373–522.
 * @returns {{ emergency: boolean, reason?: string, emergencyType?: string, category?: string }}
 */
function hardEmergency_(message) {
  const t = String(message || "").toLowerCase();

  const detectorMaintenanceContext =
    /\b(battery|chirping|beeping|replacement|needs replacement|replace battery|low battery|dead battery|battery (low|dead|replacement))\b/.test(
      t
    ) && /\b(detector|alarm)\b/.test(t);

  const activeDanger =
    /\b(smell(s|ing)?\s*smoke|smoke\s+(coming|in the|everywhere|full of)|apartment\s+(full of\s+)?smoke|active\s+smoke|flames?|on fire|burning|gas\s+smell|smell(s|ing)?\s+gas|carbon\s+monoxide\s+leak|smoke\s+coming\s+from)\b/.test(
      t
    ) ||
    /\b(going\s+off|alarm\s+going\s+off)\b.*\b(smoke|dizzy|sick|symptoms|feel\s+(dizzy|sick|ill)|faint)\b/.test(
      t
    ) ||
    /\b(smoke|dizzy|sick|symptoms)\b.*\b(going\s+off|alarm\s+going\s+off)\b/.test(t);

  if (detectorMaintenanceContext && !activeDanger) {
    return { emergency: false, reason: "detector_maintenance_guard" };
  }

  const hasCO =
    /\bcarbon monoxide\b/.test(t) ||
    /\bco alarm\b/.test(t) ||
    /\bco detector\b/.test(t) ||
    /\bcarbon monoxide alarm\b/.test(t);

  const hasGasSmellOrLeak =
    /\bsmell(s|ing)?\s+gas\b/.test(t) ||
    /\bgas smell\b/.test(t) ||
    /\bgas leak\b/.test(t) ||
    /\bleaking gas\b/.test(t);

  const hasSmokeOrFire =
    /\bsmoke\b/.test(t) ||
    /\bsmoke alarm\b/.test(t) ||
    /\bsmoke detector\b/.test(t) ||
    /\bfire\b/.test(t) ||
    /\bon fire\b/.test(t) ||
    /\boven\s*(is\s*)?on fire\b/.test(t) ||
    /\bflames?\b/.test(t) ||
    /\bsmolder(ing)?\b/.test(t);

  if (hasCO || hasGasSmellOrLeak || hasSmokeOrFire) {
    return {
      emergency: true,
      category: "Safety",
      emergencyType: "Gas / CO / Smoke / Fire",
    };
  }

  const floodingEmergency =
    /\bflood(ing)?\b/.test(t) ||
    /\bwater (everywhere|all over)\b/.test(t) ||
    /\b(rain(ing)?|waterfall)\b.*\binside\b/.test(t) ||
    /\bwater coming in\b/.test(t) ||
    /\bwater\s*pouring\b|\bpouring\s*water\b/.test(t) ||
    (/\bwater intrusion\b/.test(t) &&
      /\b(ceiling|wall|walls|window|roof)\b/.test(t)) ||
    /\bpipe\s*burst\b|\bburst\s*pipe\b/.test(t) ||
    /\bwater\s*pipe\s*burst\b|\bburst\s*(pipe|line|hose)\b/.test(t) ||
    /\bburst\b.*\b(pipe|line|hose)?\b/.test(t) ||
    /\b(gushing|pouring|spraying|shooting)\b/.test(t) ||
    /\bceiling\b.*\b(leak(ing)?|drip(ping)?|water)\b/.test(t) ||
    /\bwater\b.*\b(through|from)\b.*\bceiling\b/.test(t) ||
    (/\b(leak|leaking)\b/.test(t) &&
      (/\b(major|severe|serious|heavy|bad)\b/.test(t) ||
        /\bactive\b/.test(t) ||
        (/\bwater\b.*\b(leak|leaking)\b/.test(t) &&
          /\b(major|severe|serious|heavy|bad)\b/.test(t)))) ||
    (/\bwater\b/.test(t) &&
      (/\b(running|won't stop|wont stop|nonstop|can't stop|cant stop)\b/.test(t) ||
        /\b(overflow(ing)?|backing up)\b/.test(t)));

  if (floodingEmergency) {
    return {
      emergency: true,
      category: "Plumbing",
      emergencyType: "Active Flooding / Ceiling Leak",
    };
  }

  const electricalDanger =
    /\bsparks?\b/.test(t) ||
    /\boutlet\b.*\b(smok(e|ing)|on fire|burn(ing)?)\b/.test(t) ||
    /\b(outlet|switch|breaker|panel|wiring)\b.*\b(burning smell|electrical smell)\b/.test(t) ||
    /\b(outlet|switch)\b.*\b(smoking|sparking)\b/.test(t);

  if (electricalDanger) {
    return {
      emergency: true,
      category: "Electrical",
      emergencyType: "Electrical Hazard",
    };
  }

  const sewageEmergency =
    /\bsewage\b/.test(t) ||
    /\bsewer\b/.test(t) ||
    /\bwaste\s*water\b/.test(t) ||
    (/\bback(ing)?\s*up\b/.test(t) && /\b(toilet|drain|tub|shower|sink)\b/.test(t)) ||
    /\btoilet overflow(ing)?\b/.test(t);

  if (sewageEmergency) {
    return {
      emergency: true,
      category: "Plumbing",
      emergencyType: "Sewage Backup",
    };
  }

  return { emergency: false };
}

/**
 * Port of `detectEmergencyKind_` — `18_MESSAGING_ENGINE.gs` ~1204–1216.
 */
function detectEmergencyKind_(text) {
  const s = String(text || "").toLowerCase();

  if (/\b(oven\s*(is\s*)?on fire|on fire|fire|flames)\b/.test(s)) return "FIRE";
  if (/\b(smoke|smoky)\b/.test(s)) return "SMOKE";
  if (/\b(gas leak|smell gas|gas smell)\b/.test(s)) return "GAS";
  if (/\b(carbon monoxide|co alarm|co detector)\b/.test(s)) return "CO";
  if (/\b(sparks|arcing|electrical fire|outlet sparks|burning outlet)\b/.test(s))
    return "ELECTRICAL";
  if (
    /\b(pipe\s*burst|burst\s*pipe|water\s*pipe\s*burst|flood(ing)?|water\s*pouring|sewage|sewer\s*back)\b/.test(
      s
    )
  )
    return "FLOOD";

  return "";
}

/**
 * Port of `evaluateEmergencySignal_` (rules slice) — `18_MESSAGING_ENGINE.gs` ~530–603.
 * @returns {{ isEmergency: boolean, emergencyType: string }}
 */
function evaluateEmergencySignal_(text) {
  const t = String(text || "").trim();
  const hard = hardEmergency_(t);

  if (hard && hard.reason === "detector_maintenance_guard") {
    return { isEmergency: false, emergencyType: "" };
  }

  if (hard && hard.emergency) {
    const emTypeRaw =
      detectEmergencyKind_(t) ||
      (hard.emergencyType || "").split("/")[0] ||
      "SAFETY";
    let emType = String(emTypeRaw)
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_")
      .slice(0, 20);
    if (!emType) emType = "EMERGENCY";
    return { isEmergency: true, emergencyType: emType };
  }

  const kind = detectEmergencyKind_(t);
  if (kind) {
    const detectorMaint =
      /\b(battery|chirping|beeping|replacement|needs replacement|replace battery|low battery)\b/.test(
        t.toLowerCase()
      ) && /\b(detector|alarm)\b/.test(t.toLowerCase());
    if (detectorMaint) {
      return { isEmergency: false, emergencyType: "" };
    }
    return { isEmergency: true, emergencyType: String(kind).trim().toUpperCase() };
  }

  return { isEmergency: false, emergencyType: "" };
}

/**
 * Sheet columns `emergency` / `emergency_type` — GAS `evaluateEmergencySignal_`.isEmergency → "Yes"/"No".
 */
function inferEmergency(issueText) {
  const sig = evaluateEmergencySignal_(issueText);
  return {
    emergency: sig.isEmergency ? "Yes" : "No",
    emergencyType: String(sig.emergencyType || "").trim(),
  };
}

/**
 * Same keyword order as GAS `localCategoryFromText_` (18_MESSAGING_ENGINE.gs ~644–702).
 * If no rule matches, returns `""` (GAS line 702). V2 callers may still treat empty as unknown.
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

  return "";
}

function buildThreadIdV2(opts) {
  const trace = String(opts.traceId || "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 12);
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
  hardEmergency_,
  detectEmergencyKind_,
  evaluateEmergencySignal_,
  localCategoryFromText,
  /** @deprecated use localCategoryFromText */
  inferCategoryLabel: localCategoryFromText,
  buildThreadIdV2,
};
