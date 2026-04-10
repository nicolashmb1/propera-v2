/**
 * Canonical inbound signal — channel-agnostic shape the brain consumes.
 * Adapters map transport payloads → InboundSignal; brain must not branch on transport.
 *
 * Aligned with PROPERA_GUARDRAILS.md: one normalized package for all inbound reality.
 */

const SCHEMA_VERSION = 1;

/** @typedef {'TELEGRAM'} InboundChannel */

/**
 * @param {object} parts
 * @param {InboundChannel} parts.channel
 * @param {Record<string, unknown>} parts.transport — ids only; no routing decisions
 * @param {Record<string, unknown>} parts.body — text / structured user content
 */
function createInboundSignal(parts) {
  return {
    schema_version: SCHEMA_VERSION,
    channel: parts.channel,
    received_at: new Date().toISOString(),
    transport: parts.transport || {},
    body: parts.body || {},
  };
}

module.exports = {
  SCHEMA_VERSION,
  createInboundSignal,
  CHANNEL_TELEGRAM: "TELEGRAM",
};
