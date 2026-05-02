/**
 * GAS parity: `reconcileTicketGroupsForFinalize_` + `groupIssueAtomsIntoTicketGroups_`
 * (`10_CANONICAL_INTAKE_ENGINE.gs` ~498–850).
 *
 * Ticket boundaries come from **issue atoms** (structured LLM issues, buffer lines, intentional `|`
 * splits, or one fallback atom). **Not** from `. ! ?` or casual "and" in free text — that was
 * brittle; GAS never used punctuation as the primary splitter for finalize groups.
 */

const { localCategoryFromText } = require("../../dal/ticketDefaults");
const { parseIssueDeterministic } = require("../gas/issueParseDeterministic");
const {
  canonicalInboundLooksScheduleOnly,
} = require("./intakeAttachClassify");
const { inferLocationTypeFromText, normalizeLocationType } = require("../shared/commonArea");
const { hasProblemSignal } = require("./splitIssueGroups");

function issueTextKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** GAS `inferRoomLocationKey_` slice */
function inferRoomLocationKey(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return "";
  if (/\b(hallway|corridor)\b/.test(t)) return "hallway";
  if (/\b(bedroom)\b/.test(t)) return "bedroom";
  if (/\b(kitchen)\b/.test(t)) return "kitchen";
  if (/\b(bathroom)\b/.test(t)) return "bathroom";
  if (/\b(living room|livingroom|den)\b/.test(t)) return "living_room";
  if (/\b(garage)\b/.test(t)) return "garage";
  if (/\b(basement)\b/.test(t)) return "basement";
  return "";
}

/** GAS `inferFixtureBaseKey_` slice */
function inferFixtureBaseKey(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return "";
  if (/\bsink\b/.test(t)) return "sink";
  if (/\btoilet\b/.test(t)) return "toilet";
  if (/\bshower\b/.test(t)) return "shower";
  if (/\btub\b/.test(t) || /\bbathtub\b/.test(t)) return "tub";
  if (/\bfaucet\b/.test(t)) return "faucet";
  if (/\bdrain\b/.test(t) || /\bbacked up\b/.test(t)) return "drain";
  if (/\bpipe\b/.test(t)) return "pipe";
  if (/\bstove\b/.test(t) || /\boven\b/.test(t) || /\brange\b/.test(t) || /\bburner\b/.test(t))
    return "stove";
  if (/\bwasher\b/.test(t) || /\bdryer\b/.test(t)) return "laundry";
  if (/\bfridge\b|\brefrigerator\b|\bfreezer\b/.test(t)) return "refrigerator";
  if (/\bdishwasher\b/.test(t)) return "dishwasher";
  if (/\bmicrowave\b/.test(t)) return "microwave";
  if (/\blight\b|\blights\b|\bbulb\b|\blamp\b|\bfixture\b/.test(t)) return "light";
  if (/\bintercom\b/.test(t)) return "intercom";
  if (/\bdoor\b/.test(t) || /\bentry\b/.test(t)) return "door";
  if (/\block\b|\blocked\b|\bkey\b|\bdeadbolt\b/.test(t)) return "lock";
  if (/\bwindow\b/.test(t)) return "window";
  if (/\bthermostat\b/.test(t)) return "thermostat";
  if (/\bac\b|\bair conditioner\b|\ba\/c\b/.test(t)) return "ac";
  if (/\bheater\b|\bboiler\b|\bradiator\b|\bfurnace\b/.test(t)) return "heater";
  if (/\boutlet\b|\bgfci\b|\breceptacle\b/.test(t)) return "outlet";
  if (/\bbreaker\b|\bpanel\b/.test(t)) return "breaker";
  if (/\bice maker\b|\bicemaker\b/.test(t)) return "icemaker";
  return "";
}

function inferFixtureKey(text) {
  const base = inferFixtureBaseKey(text);
  if (!base) return "";
  const room = inferRoomLocationKey(text);
  if (
    room &&
    (base === "light" || base === "door" || base === "outlet" || base === "lock" || base === "window")
  ) {
    return `${room}|${base}`;
  }
  return base;
}

function safeInferLocationTypeAndInUnit(rawText) {
  const lt = normalizeLocationType(inferLocationTypeFromText(rawText));
  if (lt === "COMMON_AREA") {
    return { locationType: "COMMON_AREA", inUnit: false };
  }
  return { locationType: "UNIT", inUnit: true };
}

/**
 * GAS `issueAtomFromProblemText_` — category + fixture + dedupe key for grouping.
 */
function issueAtomFromProblemText(rawText, sourceStage) {
  const rt = String(rawText || "").trim();
  if (rt.length < 3) return null;
  if (canonicalInboundLooksScheduleOnly(rt)) return null;

  const atomTitle = rt;
  let category = String(localCategoryFromText(rt) || "").trim();
  if (!category) category = "General";
  const faultFamilyKey = category;
  const fixtureKey = inferFixtureKey(rt) || "unknown_fixture";
  const loc = safeInferLocationTypeAndInUnit(rt);
  const dedupeKey = [
    category,
    faultFamilyKey,
    fixtureKey,
    issueTextKey(atomTitle).slice(0, 80),
  ].join("|");

  return {
    rawText: rt.slice(0, 500),
    normalizedTitle: atomTitle.slice(0, 500),
    category,
    faultFamilyKey,
    fixtureKey,
    locationType: loc.locationType,
    inUnit: loc.inUnit,
    urgency: "Normal",
    sourceStage: String(sourceStage || ""),
    dedupeKey,
  };
}

/**
 * GAS `issueAtomFromSchemaIssue_` — V2 canonized `issues[]` row (`canonizeStructuredSignal.js`).
 */
function issueAtomFromSchemaIssue(issueObj, sourceStage) {
  if (!issueObj || typeof issueObj !== "object") return null;
  const td = String(issueObj.tenantDescription || "").trim();
  const sum = String(issueObj.summary || issueObj.title || "").trim();
  const raw = td.length >= 4 ? td : sum;
  if (raw.length < 3) return null;

  let category = String(issueObj.category || "").trim();
  if (!category) category = String(localCategoryFromText(raw) || "").trim();
  if (!category) category = "General";

  const faultFamilyKey = category;
  const fixtureKey = inferFixtureKey(raw) || inferFixtureKey(sum) || "unknown_fixture";
  const lt = String(issueObj.locationType || "UNIT").toUpperCase();
  const loc =
    lt === "COMMON_AREA"
      ? { locationType: "COMMON_AREA", inUnit: false }
      : safeInferLocationTypeAndInUnit(raw);

  const dedupeKey = [category, faultFamilyKey, fixtureKey, issueTextKey(sum || raw).slice(0, 80)].join(
    "|"
  );

  return {
    rawText: raw.slice(0, 500),
    normalizedTitle: sum.slice(0, 500) || raw.slice(0, 500),
    category,
    faultFamilyKey,
    fixtureKey,
    locationType: loc.locationType,
    inUnit: loc.inUnit,
    urgency: String(issueObj.urgency || "").toLowerCase() === "urgent" ? "Urgent" : "Normal",
    sourceStage: String(sourceStage || ""),
    dedupeKey,
  };
}

function dedupeIssueAtomsByDedupeKey(atoms) {
  const seen = new Set();
  const out = [];
  for (const a of atoms || []) {
    if (!a || !a.dedupeKey) continue;
    if (seen.has(a.dedupeKey)) continue;
    seen.add(a.dedupeKey);
    out.push(a);
  }
  return out;
}

/**
 * GAS `groupIssueAtomsIntoTicketGroups_` (~618–677).
 */
function groupIssueAtomsIntoTicketGroups(issueAtoms) {
  const atoms = Array.isArray(issueAtoms) ? issueAtoms : [];
  const map = {};
  const orderedKeys = [];

  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (!a) continue;
    const gk = [
      String(a.category || "").trim() || "General",
      String(a.fixtureKey || "").trim() || "unknown_fixture",
      String(a.faultFamilyKey || "").trim() || "unknown_fault",
    ].join("|");

    if (!map[gk]) {
      map[gk] = {
        trade: String(a.category || "").trim() || "General",
        fixtureKey: String(a.fixtureKey || "").trim() || "unknown_fixture",
        faultFamilyKey: String(a.faultFamilyKey || "").trim() || "unknown_fault",
        atoms: [],
        locationType: String(a.locationType || "UNIT").toUpperCase(),
        inUnit: !!a.inUnit,
        urgency: String(a.urgency || "Normal"),
      };
      orderedKeys.push(gk);
    }
    if (String(a.locationType || "").toUpperCase() === "COMMON_AREA") {
      map[gk].locationType = "COMMON_AREA";
      map[gk].inUnit = false;
    }
    if (String(a.urgency || "").toLowerCase() === "urgent") map[gk].urgency = "Urgent";
    map[gk].atoms.push(a);
  }

  const groups = [];
  for (let oi = 0; oi < orderedKeys.length; oi++) {
    const g0 = map[orderedKeys[oi]];
    if (!g0 || !g0.atoms || !g0.atoms.length) continue;
    const issueTexts = g0.atoms
      .map((x) => String(x.normalizedTitle || x.rawText || "").trim())
      .filter(Boolean);
    const groupMessageRaw = issueTexts.join(" | ").slice(0, 900);
    const groupTitle = issueTexts[0] || orderedKeys[oi];

    groups.push({
      groupKey: orderedKeys[oi],
      groupTitle,
      groupMessageRaw,
      trade: g0.trade,
      fixtureKey: g0.fixtureKey,
      faultFamilyKey: g0.faultFamilyKey,
      locationType: g0.locationType === "COMMON_AREA" ? "COMMON_AREA" : "UNIT",
      inUnit: g0.locationType === "COMMON_AREA" ? false : true,
      urgency: g0.urgency,
    });
  }
  return groups;
}

/**
 * Roll AC subsystem clauses (filter/drain/etc.) to fixtureKey `ac` so same-system
 * sub-issues stay one ticket (see tests/splitIssueGroups.test.js).
 */
function normalizeAtomAcSubsystemRollup(atom) {
  if (!atom) return atom;
  const t = String(atom.rawText || atom.normalizedTitle || "").toLowerCase();
  if (!/\bac\b|\ba\/c\b|air conditioner/.test(t)) return atom;
  if (!/\b(filter|drain|clog|condenser|coil|freon|coolant)\b/.test(t)) return atom;
  // Group key uses category|fixtureKey|faultFamilyKey — align all AC subsystem clauses.
  return {
    ...atom,
    fixtureKey: "ac",
    category: "HVAC",
    faultFamilyKey: "HVAC",
  };
}

/**
 * Deterministic multi-issue grouping for free text (parse clauses → atoms → GAS-style groups).
 * Used by regression tests; same atoms path as finalize reconciliation helpers.
 */
function buildIssueTicketGroups(freeText) {
  const raw = String(freeText || "").trim();
  if (!raw) return [];
  const parsed = parseIssueDeterministic(raw);
  const clauses = Array.isArray(parsed.clauses) ? parsed.clauses : [];
  const atoms = [];
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    const t = String(c && c.text ? c.text : "").trim();
    if (!t) continue;
    const atom = issueAtomFromProblemText(t, "build_issue_groups");
    if (atom) atoms.push(atom);
  }
  let merged = atoms.length
    ? atoms.map(normalizeAtomAcSubsystemRollup)
    : [];
  if (!merged.length) {
    const atom = issueAtomFromProblemText(raw, "build_issue_fallback");
    if (atom) merged.push(normalizeAtomAcSubsystemRollup(atom));
  }
  merged = dedupeIssueAtomsByDedupeKey(merged);
  return groupIssueAtomsIntoTicketGroups(merged);
}

function expandAtomsPipeSplit(atoms) {
  const expanded = [];
  for (const a of atoms || []) {
    if (!a) continue;
    const t = String(a.normalizedTitle != null ? a.normalizedTitle : a.rawText || "").trim();
    if (t && t.indexOf("|") >= 0) {
      const segs = t.split(/\s*\|\s*/);
      for (let ss = 0; ss < segs.length; ss++) {
        const seg = String(segs[ss] || "").trim();
        if (seg.length < 4) continue;
        if (canonicalInboundLooksScheduleOnly(seg)) continue;
        const na = issueAtomFromProblemText(seg, "finalize_atom_split");
        if (na) expanded.push(na);
      }
    } else {
      expanded.push(a);
    }
  }
  return expanded;
}

/**
 * Strip structured LLM rows when this turn is a short slot reply (#dN common area) but merged draft
 * holds the real issue — avoids poisoning atoms with LLM paraphrase.
 */
function resolveStructuredIssuesForFinalize(structuredIssues, mergedIssueText, effectiveBody) {
  const s = Array.isArray(structuredIssues) ? structuredIssues : null;
  if (!s || !s.length) return null;
  const merged = String(mergedIssueText || "").trim();
  const body = String(effectiveBody || "").trim();
  if (merged.length >= 60 && body.length > 0 && body.length < 56 && merged.length > body.length * 3) {
    return null;
  }
  return s;
}

/** Same raw line `issueAtomFromSchemaIssue` uses for classification. */
function rawFromStructuredIssue(iss) {
  if (!iss || typeof iss !== "object") return "";
  const td = String(iss.tenantDescription || "").trim();
  const sum = String(iss.summary || iss.title || "").trim();
  return td.length >= 4 ? td : sum;
}

function structuredIssueHasProblemSignal(iss) {
  const raw = rawFromStructuredIssue(iss);
  if (hasProblemSignal(raw)) return true;

  const category = String(iss && iss.category ? iss.category : "")
    .trim()
    .toLowerCase();
  const hasSpecificCategory =
    category && category !== "general" && category !== "other" && category !== "unknown";
  const hasFixture = !!inferFixtureKey(raw);

  return hasSpecificCategory && hasFixture;
}

/**
 * Multi-ticket split only when **≥2 structured rows look like real problems** (category / symptom).
 * Mixed metadata + problem (e.g. address-only + icemaker) → keep **problem rows only** for atoms,
 * single ticket — avoids junk ticket #1 with address/unit only.
 */
function pickStructuredIssuesForFinalizeAtoms(structured) {
  const s = Array.isArray(structured) ? structured.filter(Boolean) : [];
  if (s.length <= 1) {
    return { issues: s, allowMultiFinalizeTickets: false };
  }
  const withProb = [];
  for (const iss of s) {
    const raw = rawFromStructuredIssue(iss);
    if (raw.length < 3) continue;
    if (structuredIssueHasProblemSignal(iss)) withProb.push(iss);
  }
  if (withProb.length >= 2) {
    return { issues: withProb, allowMultiFinalizeTickets: true };
  }
  if (withProb.length === 1) {
    return { issues: withProb, allowMultiFinalizeTickets: false };
  }
  return { issues: s, allowMultiFinalizeTickets: false };
}

/**
 * GAS `reconcileTicketGroupsForFinalize_` — inputs mapped to V2 session shapes.
 *
 * @param {{
 *   structuredIssues?: Array<object>|null,
 *   mergedIssueText: string,
 *   issueBufferLines?: string[],
 *   effectiveBody?: string,
 * }} o
 * Multiple finalize rows only when **≥2 structured issues pass `hasProblemSignal`** (clear problems).
 * Otherwise multi-groups collapse to one ticket with ` \| ` — prefer one solid ticket over thin splits.
 * @returns {{ rows: Array<{ key: string, issueText: string }> }}
 */
function reconcileFinalizeTicketRows(o) {
  const mergedIssue = String(o.mergedIssueText || "").trim();
  const effectiveBody = String(o.effectiveBody != null ? o.effectiveBody : "").trim();

  const structuredResolved = resolveStructuredIssuesForFinalize(
    o.structuredIssues,
    mergedIssue,
    effectiveBody
  );
  const picked = pickStructuredIssuesForFinalizeAtoms(structuredResolved || []);
  const structuredForAtoms = picked.issues;
  const allowMulti = picked.allowMultiFinalizeTickets;
  const hasStructuredProblemAtoms =
    structuredForAtoms.length > 0 &&
    structuredForAtoms.some((iss) => structuredIssueHasProblemSignal(iss));

  const atoms = [];

  // GAS order: structured package issues → durable buffer → pipe-split merged → fallback whole.
  if (structuredForAtoms && structuredForAtoms.length) {
    for (let i = 0; i < structuredForAtoms.length; i++) {
      const ak = issueAtomFromSchemaIssue(structuredForAtoms[i], "STRUCTURED");
      if (ak) atoms.push(ak);
    }
  }

  if (!allowMulti) {
    const buf = Array.isArray(o.issueBufferLines) ? o.issueBufferLines : [];
    for (let ib = 0; ib < buf.length; ib++) {
      const rt = String(buf[ib] || "").trim();
      if (!rt) continue;
      if (hasStructuredProblemAtoms && !hasProblemSignal(rt)) continue;
      const ab = issueAtomFromProblemText(rt, "finalize_buf");
      if (ab) atoms.push(ab);
    }

    if (mergedIssue.indexOf("|") >= 0) {
      const segs = mergedIssue.split(/\s*\|\s*/);
      for (let is = 0; is < segs.length; is++) {
        const seg = String(segs[is] || "").trim();
        if (seg.length < 4) continue;
        if (canonicalInboundLooksScheduleOnly(seg)) continue;
        if (hasStructuredProblemAtoms && !hasProblemSignal(seg)) continue;
        const as = issueAtomFromProblemText(seg, "finalize_pipe");
        if (as) atoms.push(as);
      }
    }
  }

  if (
    !atoms.length &&
    mergedIssue.length >= 4 &&
    !canonicalInboundLooksScheduleOnly(mergedIssue)
  ) {
    const af = issueAtomFromProblemText(mergedIssue, "finalize_fallback_whole");
    if (af) atoms.push(af);
  }

  let expanded = expandAtomsPipeSplit(atoms);
  expanded = dedupeIssueAtomsByDedupeKey(expanded);
  const groups = groupIssueAtomsIntoTicketGroups(expanded);

  const rows = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g) continue;
    const msg = String(g.groupMessageRaw || g.groupTitle || "").trim();
    if (!msg) continue;
    const trade = String(g.trade || "General")
      .replace(/\s+/g, "_")
      .toUpperCase();
    rows.push({
      key: trade + "_" + String(g.fixtureKey || "x").replace(/\|/g, "_"),
      issueText: msg,
    });
  }

  if (!rows.length && mergedIssue.length >= 2) {
    rows.push({ key: "single", issueText: mergedIssue.slice(0, 900) });
  }

  // V2 product policy: collapse heuristic multi-rows unless **≥2 clear structured problems**.
  if (rows.length > 1 && !allowMulti) {
    const combined = rows
      .map((r) => String(r.issueText || "").trim())
      .filter(Boolean)
      .join(" | ")
      .slice(0, 900);
    return {
      rows: [{ key: "single", issueText: combined || mergedIssue.slice(0, 900) }],
    };
  }

  return { rows };
}

module.exports = {
  reconcileFinalizeTicketRows,
  issueAtomFromProblemText,
  issueAtomFromSchemaIssue,
  groupIssueAtomsIntoTicketGroups,
  dedupeIssueAtomsByDedupeKey,
  resolveStructuredIssuesForFinalize,
  pickStructuredIssuesForFinalizeAtoms,
  rawFromStructuredIssue,
  structuredIssueHasProblemSignal,
  buildIssueTicketGroups,
};
