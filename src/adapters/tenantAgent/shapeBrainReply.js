/**
 * Post-handoff tenant reply — canonical maintenance receipt from brain facts only (Sprint 3).
 * See docs/TENANT_AGENT_ADAPTER.md §9 and docs/OUTGATE_VOICE_SPEC.md.
 */
const { buildMaintenanceReceipt } = require("../../outgate/buildMaintenanceReceipt");
const { extractBrainReceiptFacts } = require("./extractBrainReceiptFacts");

const FINALIZE_FAILED_REPLY =
  "Sorry — we couldn't save your request just now. Please try again in a minute or call the office.";

const PORTAL_INVALID_REPLY =
  "I need a bit more detail to finish your request — please send your building and what needs fixing.";

/**
 * Keep schedule / policy suffixes brain appended after the receipt block.
 * @param {string} canonical
 * @param {string} original
 * @returns {string}
 */
function mergeReceiptWithBrainSuffix(canonical, original) {
  const base = String(canonical || "").trim();
  const orig = String(original || "").trim();
  if (!orig) return base;
  if (!base) return orig;
  if (orig === base) return base;
  if (orig.startsWith(base)) {
    const suffix = orig.slice(base.length).trim();
    return suffix ? `${base}\n\n${suffix}` : base;
  }
  if (/Ref #/i.test(orig)) return orig;
  return base || orig;
}

/**
 * @param {object | null | undefined} coreRun
 * @returns {string}
 */
function shapeBrainReplyForTenantAgent(coreRun) {
  if (!coreRun || typeof coreRun !== "object") return "";

  const brain = String(coreRun.brain || "").trim();
  const original = String(coreRun.replyText || "").trim();

  if (brain === "core_finalize_failed") {
    return FINALIZE_FAILED_REPLY;
  }
  if (brain === "portal_create_invalid") {
    return PORTAL_INVALID_REPLY;
  }
  if (brain !== "core_finalized") {
    return original;
  }

  const facts = extractBrainReceiptFacts(coreRun);
  if (!facts) {
    return original;
  }

  if (facts.multi) {
    return original;
  }

  const built = buildMaintenanceReceipt({
    fins: facts.fins,
    groups: facts.groups,
    emergency: facts.emergency,
    emergencyType: facts.emergencyType,
    commonArea: facts.commonArea,
    unitLabel: facts.unitLabel,
    locationLabelSnapshot: facts.locationLabelSnapshot,
    propertyCode: facts.propertyCode,
    propertyDisplayName: facts.propertyDisplayName,
  });

  const outgate =
    coreRun.outgate && typeof coreRun.outgate === "object" ? coreRun.outgate : {};
  if (outgate.templateKey !== built.templateKey) {
    coreRun.outgate = { ...outgate, templateKey: built.templateKey };
  }

  if (built.tier === "emergency") {
    return built.body;
  }

  return mergeReceiptWithBrainSuffix(built.body, original);
}

module.exports = {
  shapeBrainReplyForTenantAgent,
  FINALIZE_FAILED_REPLY,
  PORTAL_INVALID_REPLY,
  mergeReceiptWithBrainSuffix,
};
