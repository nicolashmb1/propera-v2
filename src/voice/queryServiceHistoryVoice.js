/**
 * Jarvis voice — service history analytics (read-only).
 */

const {
  queryServiceHistory,
  formatServiceHistoryReply,
  formatServiceHistorySpeak,
  expandIssueKeywords,
  parseServiceHistoryAnalysis,
} = require("../agent/jarvisQuery");

const ANALYSIS_MODES = new Set([
  "summary",
  "distinct_units",
  "repeat_units",
  "unit_breakdown",
]);

/**
 * @param {object} args
 */
function resolveAnalysisMode(args) {
  const raw = String(
    args.analysis || args.analysis_mode || args.analysisMode || ""
  )
    .trim()
    .toLowerCase();
  if (ANALYSIS_MODES.has(raw)) return raw;
  const fromQuestion = parseServiceHistoryAnalysis(
    String(args.follow_up_question || args.question || "")
  );
  return ANALYSIS_MODES.has(fromQuestion) ? fromQuestion : "summary";
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function queryServiceHistoryVoice(args, ctx) {
  const issueRaw =
    args.issue_keywords ||
    args.issueKeywords ||
    args.issue ||
    args.keywords ||
    args.issue_label ||
    args.issueLabel;
  let keywords = [];
  if (Array.isArray(issueRaw)) {
    keywords = issueRaw.flatMap((k) => expandIssueKeywords(String(k)));
  } else {
    keywords = expandIssueKeywords(String(issueRaw || "").trim());
  }
  keywords = [...new Set(keywords)].filter(Boolean);

  if (!keywords.length) {
    return {
      error: "missing_issue",
      message: "Need issue_keywords — e.g. refrigerator, dishwasher, heat.",
      speak: "What kind of issue should I count?",
    };
  }

  const daysBack = Number(args.days_back ?? args.daysBack ?? 30) || 30;
  const propertyCode = String(
    args.property_code ||
      args.propertyCode ||
      ctx.pageContext?.propertyCode ||
      ctx.scope?.anchor?.propertyCode ||
      ""
  )
    .trim()
    .toUpperCase();
  const issueLabel = String(
    args.issue_label || args.issueLabel || issueRaw || keywords[0] || "matching"
  ).trim();
  const analysisMode = resolveAnalysisMode(args);

  const result = await queryServiceHistory({
    issueKeywords: keywords,
    daysBack,
    propertyCode: propertyCode || undefined,
    issueLabel,
    analysisMode,
  });

  if (!result.ok) {
    return {
      error: result.error || "query_failed",
      message: result.message || "Could not run history query.",
      speak: "I couldn't look that up right now.",
    };
  }

  return {
    count: result.count,
    days_back: result.daysBack,
    issue_label: result.issueLabel,
    property_code: result.propertyCode,
    analysis: result.analysisMode,
    distinct_unit_count: result.unitAnalysis?.distinctUnitCount ?? null,
    repeat_unit_count: result.unitAnalysis?.repeatUnitCount ?? null,
    repeat_units: result.unitAnalysis?.repeatUnits ?? [],
    unit_breakdown: result.unitAnalysis?.unitBreakdown ?? [],
    tickets: result.tickets,
    text: formatServiceHistoryReply(result),
    speak: formatServiceHistorySpeak(result),
    read_only: true,
  };
}

module.exports = { queryServiceHistoryVoice, resolveAnalysisMode };
