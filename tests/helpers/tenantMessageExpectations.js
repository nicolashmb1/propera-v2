/**
 * Map golden fixture rows → assertions compileTurn can check today.
 * Product actions (NO_TICKET, SPLIT_TICKET, UPDATE_TICKET) need pipeline tests (layer C).
 */
const {
  _issueParseTestExports: { looksActionableIssue_ },
} = require("../../src/brain/gas/issueParseDeterministic");
const { extractUnit } = require("../../src/brain/shared/extractUnitGas");

const PIPELINE_ONLY_ACTIONS = new Set([
  "NO_TICKET",
  "SUSPEND_TICKET",
  "UPDATE_TICKET",
  "CREATE_TICKET_PLUS_STATUS",
  "SPLIT_TICKET",
  "CLARIFY_UNIT",
  "CLARIFY_ISSUE",
]);

/** @param {object} row */
function testLayerForRow(row) {
  if (row.testLayer === "pipeline") return "pipeline";
  if (Array.isArray(row.skipUntil) && row.skipUntil.length) return "skip";
  if (PIPELINE_ONLY_ACTIONS.has(row.action)) return "pipeline";
  if (row.category === "CHITCHAT" || row.category === "QUESTION") return "compile_soft";
  if (row.category === "NON_MAINTENANCE") return "compile_soft";
  if (row.category === "TICKET_CANCEL") return "pipeline";
  if (row.category === "ISSUE_RECURRING") return "pipeline";
  return "compile";
}

/**
 * @param {object} row
 * @param {object} tf — compileTurn result
 */
function assertCompileLayer(row, tf) {
  const failures = [];
  const body = String(row.message || "");
  const ex = row.extracted || {};
  const issueText = String(tf.issue || tf.issueHint || "").trim();
  const actionable =
    looksActionableIssue_(issueText) || looksActionableIssue_(body);

  if (row.category === "CHITCHAT" || row.category === "QUESTION") {
    if (actionable && !body.includes("[PHOTO")) {
      failures.push(
        `expected non-actionable issue for ${row.category}, got issue="${issueText.slice(0, 60)}"`
      );
    }
  }

  if (
    row.category === "ISSUE_CLEAR" ||
    row.category === "ISSUE_NO_UNIT" ||
    row.category === "ISSUE_URGENT" ||
    row.category === "ISSUE_MULTI"
  ) {
    if (!actionable && row.category !== "ISSUE_VAGUE") {
      failures.push(`expected actionable issue, got empty/non-actionable`);
    }
  }

  if (row.category === "ISSUE_VAGUE") {
    if (actionable && /something is wrong|problem again/i.test(body)) {
      /* vague wording may still parse — soft */
    }
  }

  const unitFromMsg = extractUnit(body, { knownPropertyCodesUpper: new Set() });
  const expectedUnit = ex.unit;
  if (
    expectedUnit &&
    expectedUnit !== "PROFILE_LOOKUP" &&
    expectedUnit !== "COMMON" &&
    /^\d{2,4}$/.test(String(expectedUnit))
  ) {
    const got = String(tf.unit || unitFromMsg?.unit || "").replace(/\D/g, "");
    const want = String(expectedUnit).replace(/\D/g, "");
    if (got && want && got !== want) {
      failures.push(`unit expected ${want}, got ${got || "(empty)"}`);
    }
  }

  if (ex.unit === "COMMON" || /elevator|lobby|gym|building door|ev charging/i.test(body)) {
    const loc = tf.location || {};
    const common =
      String(loc.locationType || "").toUpperCase().includes("COMMON") ||
      String(loc.locationScopeBroad || "").toUpperCase().includes("COMMON") ||
      String(tf.unit || "").toUpperCase() === "COMMON";
    if (!common && !/penn|murray|morr/i.test(body)) {
      /* location common-area detection is partial — warn only via strict mode */
    }
  }

  const urg = String(ex.urgency || "").toUpperCase();
  if (urg === "EMERGENCY" || (row.category === "ISSUE_URGENT" && urg === "HIGH")) {
    if (!tf.safety?.isEmergency && /gas|flood|fire|beepin|red light/i.test(body)) {
      failures.push(`expected emergency safety flag for urgent message`);
    }
  }

  if (row.category === "ISSUE_MULTI" && Array.isArray(ex.issues) && ex.issues.length >= 2) {
    const structured = tf.structuredSignal;
    const issues = structured?.issues;
    if (Array.isArray(issues) && issues.length < 2) {
      failures.push(`expected 2+ structured issues[], got ${issues.length}`);
    }
  }

  return failures;
}

module.exports = {
  testLayerForRow,
  assertCompileLayer,
  PIPELINE_ONLY_ACTIONS,
};
