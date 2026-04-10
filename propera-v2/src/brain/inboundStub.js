/**
 * Legacy placeholder — Telegram webhook now uses evaluateRouterPrecursor + ported GAS precursors.
 * Reserved for non-Telegram channels until those routes call the real router stack.
 */

const { emit } = require("../logging/structuredLog");

/**
 * @param {object} signal — normalized inbound (any channel)
 * @param {{ traceId: string }} ctx
 * @returns {Promise<{ phase: string, brain: string }>}
 */
async function processInboundSignalStub(signal, ctx) {
  const traceId = ctx.traceId || null;
  emit({
    level: "info",
    trace_id: traceId,
    log_kind: "brain_inbound_stub",
    event: "accept",
    data: {
      schema_version: signal.schema_version,
      channel: signal.channel,
      transport_keys: signal.transport ? Object.keys(signal.transport) : [],
    },
  });
  return { phase: "stub", brain: "noop_until_ported" };
}

module.exports = { processInboundSignalStub };
