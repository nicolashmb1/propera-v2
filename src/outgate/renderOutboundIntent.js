/**
 * Outgate render: intent + optional MessageSpec → channel-ready body (Phase 1).
 * Agent refinement: `OUTBOUND_AGENT_REFINE=1` (not implemented yet — deterministic path only).
 */

/**
 * @param {object} o
 * @param {import("./outboundIntent").OutboundIntent} o.intent
 * @param {import("./messageSpecs").MessageSpec | null} [o.messageSpec]
 * @returns {{ body: string, meta: { intentType: string, templateKey: string | null, renderSource: string } }}
 */
function renderOutboundIntent(o) {
  const intent = o.intent;
  const messageSpec = o.messageSpec || null;

  /** Non-empty intent body wins (e.g. lifecycle staff pings with ticket/property context). */
  const intentText = String(intent.replyText || "").trim();
  const specText =
    messageSpec && String(messageSpec.fallbackText || "").trim()
      ? String(messageSpec.fallbackText).trim()
      : "";

  let body = "";
  let renderSource = "intent_reply_text";
  if (intentText) {
    body = intentText;
    renderSource = "intent_reply_text";
  } else if (specText) {
    body = specText;
    renderSource = "message_spec_fallback";
  }

  const co =
    intent.facts &&
    typeof intent.facts === "object" &&
    intent.facts.coreOutgate &&
    typeof intent.facts.coreOutgate === "object"
      ? intent.facts.coreOutgate
      : null;

  return {
    body,
    meta: {
      intentType: intent.intentType,
      templateKey: messageSpec ? messageSpec.templateKey : null,
      renderSource,
      maintenanceTemplateKey: co && co.templateKey ? co.templateKey : null,
      coreOutgate: co,
    },
  };
}

module.exports = { renderOutboundIntent };
