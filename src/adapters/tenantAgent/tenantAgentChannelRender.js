/**
 * Tenant Agent → outgate channel render hints (Sprint 3).
 * Gather turns stay conversational; post-handoff uses full tenant channel extras.
 */

/**
 * @param {object} o
 * @param {string | null | undefined} [o.tenantAgentBrain] — tenant_agent_gather | tenant_agent_escalated | …
 * @param {boolean} [o.afterHandoff]
 * @returns {{ phase: 'gather'|'handoff'|'escalated'|'other', applyTelegramReceiptMarkdown: boolean, threadTenantLocale: string }}
 */
function resolveTenantAgentChannelRender(o) {
  const brain = String(o.tenantAgentBrain || "").trim();
  const afterHandoff = !!o.afterHandoff;
  const locale = String(o.tenantLocale || "en").trim() || "en";

  if (brain === "tenant_agent_gather" || brain === "tenant_agent_non_maintenance_deflect") {
    return {
      phase: "gather",
      applyTelegramReceiptMarkdown: false,
      threadTenantLocale: locale,
    };
  }
  if (brain === "tenant_agent_post_handoff" || brain === "tenant_agent_escalated") {
    return {
      phase: brain === "tenant_agent_escalated" ? "escalated" : "post_handoff",
      applyTelegramReceiptMarkdown: false,
      threadTenantLocale: locale,
    };
  }
  if (afterHandoff) {
    return {
      phase: "handoff",
      applyTelegramReceiptMarkdown: true,
      threadTenantLocale: locale,
    };
  }

  return {
    phase: "other",
    applyTelegramReceiptMarkdown: true,
    threadTenantLocale: locale,
  };
}

module.exports = { resolveTenantAgentChannelRender };
