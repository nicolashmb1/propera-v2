/**
 * Deterministic parse: natural language → service history query params.
 */

const { expandIssueKeywords } = require("./issueKeywordSynonyms");
const { parseServiceHistoryAnalysis } = require("./parseServiceHistoryAnalysis");

const PROPERTY_IN_QUESTION_RE = /\b(?:at|for|on)\s+([A-Z][A-Z0-9-]{1,11})\b/i;

/**
 * @param {string} question
 * @param {{ propertyCode?: string }} [scopeHint]
 * @returns {{ keywords: string[], daysBack: number, propertyCode?: string, issueLabel: string, analysisMode: string } | null}
 */
function parseServiceHistoryQuestion(question, scopeHint) {
  const q = String(question || "").trim();
  if (!q) return null;

  const ql = q.toLowerCase();
  const wantsCount =
    /how many|how much|count|number of|total\b/.test(ql) ||
    /\bissues?\b|\btickets?\b|\bservices?\b/.test(ql);
  if (!wantsCount) return null;

  const hasTime =
    /last\s+\d+\s+days?|past\s+\d+\s+days?|\d+\s+days?|last\s+month|this\s+month|last\s+\d+\s+weeks?/.test(
      ql
    );
  if (!hasTime && !/how many/.test(ql)) return null;

  let daysBack = 30;
  let issuePhrase = "";

  let m = q.match(
    /how many\s+(.+?)\s+(?:issue|ticket|service|problem)?s?\s*(?:did we have|have we had|were there|we had)?\s*(?:in |over |during )?(?:the )?last\s+(\d+)\s+days?/i
  );
  if (m) {
    issuePhrase = m[1].trim();
    daysBack = Number(m[2]) || 30;
  }

  if (!m) {
    m = q.match(
      /how many\s+(.+?)\s+(?:in |over |during )?(?:the )?last\s+(\d+)\s+days?/i
    );
    if (m) {
      issuePhrase = m[1].trim();
      daysBack = Number(m[2]) || 30;
    }
  }

  if (!m) {
    m = q.match(
      /(.+?)\s+(?:issue|ticket|service)s?\s+(?:in |over |during )?(?:the )?last\s+(\d+)\s+days?/i
    );
    if (m) {
      issuePhrase = m[1].trim();
      daysBack = Number(m[2]) || 30;
    }
  }

  if (!m && /last\s+(\d+)\s+days?/i.test(q)) {
    m = q.match(/last\s+(\d+)\s+days?\s+(?:of\s+)?(.+)/i);
    if (m) {
      daysBack = Number(m[1]) || 30;
      issuePhrase = m[2].trim();
    }
  }

  if (!m && /last\s+month/i.test(q)) {
    daysBack = 30;
    issuePhrase = q.replace(/.*how many\s+/i, "").replace(/\s+.*last month.*/i, "").trim();
  }

  if (!issuePhrase) return null;

  issuePhrase = issuePhrase
    .replace(/\s+(?:at|for|in)\s+[A-Z][A-Z0-9-]*\s*$/i, "")
    .replace(/\s+(?:issue|ticket|service|problem)s?\s*$/i, "")
    .trim();

  const keywords = expandIssueKeywords(issuePhrase);
  if (!keywords.length) return null;

  let propertyCode = String(scopeHint?.propertyCode || "")
    .trim()
    .toUpperCase();
  const propMatch = q.match(PROPERTY_IN_QUESTION_RE);
  if (propMatch) {
    propertyCode = String(propMatch[1]).trim().toUpperCase();
  }

  daysBack = Math.min(Math.max(daysBack, 1), 365);

  return {
    keywords,
    daysBack,
    propertyCode: propertyCode || undefined,
    issueLabel: issuePhrase.slice(0, 80),
    analysisMode: parseServiceHistoryAnalysis(q),
  };
}

module.exports = { parseServiceHistoryQuestion };
