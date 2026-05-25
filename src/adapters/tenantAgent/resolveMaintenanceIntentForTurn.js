/**
 * Resolve maintenance vs non-maintenance — regex fast path, LLM when enabled, safe fallback.
 */
const { openaiApiKey, tenantAgentLlmEnabled } = require("../../config/env");
const {
  isNonMaintenanceRequest,
  isMaintenanceRepairRequest,
} = require("./classifyNonMaintenanceRequest");
const { classifyMaintenanceIntentWithLlm } = require("./classifyMaintenanceIntentWithLlm");

/**
 * @param {object} o
 * @param {string} o.bodyText
 * @param {object | null} [o.conv]
 * @param {object} [o.partial]
 * @param {string} [o.traceId]
 * @returns {Promise<{ intent: 'maintenance_repair' | 'non_maintenance', source: string, reason?: string }>}
 */
async function resolveMaintenanceIntentForTurn(o) {
  const bodyText = String(o.bodyText || "").trim();
  const partial = o.partial || (o.conv && o.conv.partial_package) || {};
  const issue = String(partial.issue || "").trim();
  const conv = o.conv || null;
  const convStatus = String((conv && conv.status) || "").trim();

  if (isNonMaintenanceRequest(bodyText)) {
    return { intent: "non_maintenance", source: "regex_body" };
  }
  if (issue.length >= 2 && isNonMaintenanceRequest(issue)) {
    return { intent: "non_maintenance", source: "regex_issue" };
  }

  if (
    issue.length >= 2 &&
    convStatus === "gathering" &&
    !isNonMaintenanceRequest(issue) &&
    isMaintenanceRepairRequest(bodyText)
  ) {
    return { intent: "maintenance_repair", source: "regex_active_gather" };
  }

  // High-confidence repair signals win over LLM — e.g. "clean the elevator, it smells bad"
  // must not be deflected as janitorial schedule FAQ.
  if (isMaintenanceRepairRequest(bodyText)) {
    return { intent: "maintenance_repair", source: "regex_repair_signal" };
  }

  if (tenantAgentLlmEnabled() && openaiApiKey()) {
    const llm = await classifyMaintenanceIntentWithLlm({
      bodyText,
      partialPackage: partial,
      recentMessages: (conv && conv.messages) || [],
      traceId: o.traceId,
    });
    if (llm.intent === "non_maintenance") {
      return { intent: "non_maintenance", source: llm.source, reason: llm.reason };
    }
    if (llm.intent === "maintenance_repair") {
      return { intent: "maintenance_repair", source: llm.source, reason: llm.reason };
    }
  }

  return { intent: "maintenance_repair", source: "default_gather" };
}

module.exports = {
  resolveMaintenanceIntentForTurn,
};
