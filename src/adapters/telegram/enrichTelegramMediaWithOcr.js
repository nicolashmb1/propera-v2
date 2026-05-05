/**
 * Telegram media OCR — thin wrapper around shared inbound checkpoint.
 * @deprecated Prefer `enrichInboundMediaWithOcr` from `brain/shared/enrichInboundMediaWithOcr` (pipeline calls it once).
 */
const {
  enrichInboundMediaWithOcr,
} = require("../../brain/shared/enrichInboundMediaWithOcr");

async function enrichTelegramMediaWithOcr(mediaList) {
  return enrichInboundMediaWithOcr(mediaList);
}

module.exports = { enrichTelegramMediaWithOcr };
