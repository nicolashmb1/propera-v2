/**
 * Twilio webhook (`application/x-www-form-urlencoded`) → RouterParameter shape (GAS `e.parameter`).
 * SMS: `From` is E.164. WhatsApp: `From` is `whatsapp:+1...`.
 *
 * @param {Record<string, string | undefined>} body — `req.body` after urlencoded parser
 * @returns {Record<string, string>}
 */
function buildRouterParameterFromTwilio(body) {
  const b = body || {};
  const from = String(b.From || "").trim();
  const isWa = from.toLowerCase().indexOf("whatsapp:") === 0;

  const numMedia = Math.min(
    10,
    Math.max(0, parseInt(String(b.NumMedia || "0"), 10) || 0)
  );
  const media = [];
  for (let i = 0; i < numMedia; i++) {
    const url = String(b["MediaUrl" + i] || "").trim();
    const contentType = String(b["MediaContentType" + i] || "").trim();
    if (url) {
      const ct = contentType || "application/octet-stream";
      const ctLower = String(ct).toLowerCase();
      media.push({
        url,
        contentType: ct,
        source: "twilio",
        kind: ctLower.startsWith("image/") ? "image" : "file",
      });
    }
  }

  return {
    _mode: "",
    _internal: "",
    _channel: isWa ? "WHATSAPP" : "SMS",
    _phoneE164: from.replace(/^whatsapp:/i, "").trim() || from,
    From: from,
    Body: String(b.Body != null ? b.Body : ""),
    To: String(b.To || "").trim(),
    MessageSid: String(b.MessageSid || b.SmsSid || "").trim(),
    SmsMessageSid: String(b.SmsMessageSid || b.MessageSid || "").trim(),
    _mediaJson: media.length ? JSON.stringify(media) : "",
  };
}

module.exports = { buildRouterParameterFromTwilio };
