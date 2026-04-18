/**
 * TCPA-style compliance (STOP/START/HELP) and `sms_opt_out` apply **only to SMS**.
 * WhatsApp, Telegram, and other channels skip compliance side effects — see `runInboundPipeline.js`.
 */

/**
 * @param {'sms' | 'whatsapp' | 'telegram' | string} transportChannel
 * @returns {boolean}
 */
function complianceSmsOnly(transportChannel) {
  return String(transportChannel || "").toLowerCase() === "sms";
}

module.exports = { complianceSmsOnly };
