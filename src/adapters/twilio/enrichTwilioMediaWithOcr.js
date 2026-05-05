/**
 * SMS / WhatsApp media OCR — thin wrapper around shared inbound checkpoint.
 * @deprecated Prefer importing `enrichInboundMediaWithOcr` from `brain/shared/enrichInboundMediaWithOcr`.
 */
const {
  enrichInboundMediaWithOcr,
} = require("../../brain/shared/enrichInboundMediaWithOcr");

async function enrichTwilioMediaWithOcr(mediaList) {
  return enrichInboundMediaWithOcr(mediaList);
}

module.exports = { enrichTwilioMediaWithOcr };
