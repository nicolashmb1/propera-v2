const { runTenantAgentTurn, recordTenantAgentHandoffResult } = require("./runTenantAgentTurn");
const { recordTenantAgentAccessResult } = require("./recordTenantAgentAccessResult");
const { isTenantAgentEligible } = require("./eligibility");
const { completenessCheck } = require("./completeness");
const { buildHandoffRouterParameterFromAgent } = require("./buildHandoffRouterParameter");
const { shapeBrainReplyForTenantAgent } = require("./shapeBrainReply");
const { extractBrainReceiptFacts } = require("./extractBrainReceiptFacts");
const { isPropertyOnTenantAgentPilot } = require("./propertyAllowlist");
const { resolveTenantAgentChannelRender } = require("./tenantAgentChannelRender");
const {
  runTenantAgentLlmTurn,
  setTenantAgentLlmForTests,
  clearTenantAgentLlmForTests,
} = require("./tenantAgentLlmTurn");
const { mergePartialFromLlm } = require("./mergePartialFromLlm");
const { buildTenantAgentGatherSystemPrompt } = require("./systemPrompt");

module.exports = {
  runTenantAgentTurn,
  recordTenantAgentHandoffResult,
  recordTenantAgentAccessResult,
  isTenantAgentEligible,
  completenessCheck,
  buildHandoffRouterParameterFromAgent,
  shapeBrainReplyForTenantAgent,
  extractBrainReceiptFacts,
  isPropertyOnTenantAgentPilot,
  resolveTenantAgentChannelRender,
  runTenantAgentLlmTurn,
  setTenantAgentLlmForTests,
  clearTenantAgentLlmForTests,
  mergePartialFromLlm,
  buildTenantAgentGatherSystemPrompt,
};
