/**
 * Pure draft slot / expiry / finalize-issue helpers for maintenance core.
 * Split from handleInboundCore for readability — no I/O.
 */
const { normalizeIssueForCompare } = require("../gas/issueParseDeterministic");
const { expiryMinutesForExpectedStage } = require("./recomputeDraftExpected");

function draftFlagsFromSlots(d) {
  const issue = String(d.draft_issue || "").trim();
  const issueBuf = Array.isArray(d.draft_issue_buf_json) ? d.draft_issue_buf_json : [];
  const prop = String(d.draft_property || "").trim();
  const unit = String(d.draft_unit || "").trim();
  const sched = String(d.draft_schedule_raw || "").trim();
  return {
    hasIssue: issue.length >= 2 || issueBuf.length >= 1,
    hasProperty: !!prop,
    hasUnit: !!unit,
    hasSchedule: !!sched,
  };
}

function computePendingExpiresAtIso(next) {
  const mins = expiryMinutesForExpectedStage(next);
  if (mins == null) return "";
  return new Date(Date.now() + mins * 60 * 1000).toISOString();
}

function issueTextForFinalize(draftIssue, issueBuf) {
  const base = String(draftIssue || "").trim();
  const extras = Array.isArray(issueBuf)
    ? issueBuf.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  if (!base && !extras.length) return "";
  const seen = new Set();
  const out = [];
  for (const x of [base, ...extras]) {
    const k = normalizeIssueForCompare(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out.join(" | ").slice(0, 900);
}

module.exports = {
  draftFlagsFromSlots,
  computePendingExpiresAtIso,
  issueTextForFinalize,
};
