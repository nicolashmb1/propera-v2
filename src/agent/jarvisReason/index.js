const {
  runJarvisReasoning,
  setReasonChatForTests,
  clearReasonChatForTests,
} = require("./runJarvisReasoning");
const { lookupTickets, TICKET_LOOKUP_TOOL_SCHEMA } = require("./ticketLookupTool");
const { lookupCosts, COST_LOOKUP_TOOL_SCHEMA } = require("./costLookupTool");
const { getTicketDetail, TICKET_DETAIL_TOOL_SCHEMA } = require("./ticketDetailTool");
const { getUnitAssets, UNIT_ASSETS_TOOL_SCHEMA } = require("./unitAssetsTool");
const {
  getUnitServiceHistory,
  UNIT_SERVICE_HISTORY_TOOL_SCHEMA,
} = require("./unitServiceHistoryTool");
const {
  searchParts,
  buildPartsLinks,
  PARTS_SEARCH_TOOL_SCHEMA,
} = require("./partsSearchTool");

module.exports = {
  runJarvisReasoning,
  lookupTickets,
  TICKET_LOOKUP_TOOL_SCHEMA,
  lookupCosts,
  COST_LOOKUP_TOOL_SCHEMA,
  getTicketDetail,
  TICKET_DETAIL_TOOL_SCHEMA,
  getUnitAssets,
  UNIT_ASSETS_TOOL_SCHEMA,
  getUnitServiceHistory,
  UNIT_SERVICE_HISTORY_TOOL_SCHEMA,
  searchParts,
  buildPartsLinks,
  PARTS_SEARCH_TOOL_SCHEMA,
  setReasonChatForTests,
  clearReasonChatForTests,
};
