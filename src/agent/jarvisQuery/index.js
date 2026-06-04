const { queryServiceHistory, ticketMatchesKeywords } = require("./queryServiceHistory");
const { parseServiceHistoryQuestion } = require("./parseServiceHistoryQuestion");
const { parseServiceHistoryAnalysis } = require("./parseServiceHistoryAnalysis");
const { analyzeUnitsFromTickets, unitKey } = require("./analyzeServiceHistoryUnits");
const {
  formatServiceHistoryReply,
  formatServiceHistorySpeak,
} = require("./formatServiceHistoryReply");
const { expandIssueKeywords } = require("./issueKeywordSynonyms");

module.exports = {
  queryServiceHistory,
  ticketMatchesKeywords,
  parseServiceHistoryQuestion,
  parseServiceHistoryAnalysis,
  analyzeUnitsFromTickets,
  unitKey,
  formatServiceHistoryReply,
  formatServiceHistorySpeak,
  expandIssueKeywords,
};
