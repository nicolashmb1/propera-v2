/**
 * Outgate Phase 4 — channel expression after intent render (see docs/OUTGATE_VOICE_SPEC.md).
 * Property header (first contact/day), SMS compliance footer, Telegram Markdown.
 */

const SMS_COMPLIANCE_FOOTER =
  "Reply STOP to opt out. Msg & data rates may apply.";

/**
 * @param {string} displayName
 * @returns {string}
 */
function buildPropertyHeaderLine(displayName) {
  const name = String(displayName || "").trim();
  if (!name) return "";
  return `${name} — maintenance`;
}

/**
 * Bold Ref # lines and emergency opener for Telegram Markdown (legacy mode).
 * @param {string} body
 * @returns {string}
 */
function applyTelegramMarkdown(body) {
  let text = String(body || "");
  text = text.replace(/^(Ref #[^\n]+)$/gm, "*$1*");
  text = text.replace(
    /^We're treating this as an emergency\.$/m,
    "*We're treating this as an emergency.*"
  );
  return text;
}

/**
 * @param {object} o
 * @param {string} o.transportChannel — sms | whatsapp | telegram | portal
 * @param {string} o.body — post–renderOutboundIntent text
 * @param {string} o.audience — tenant | staff | unknown
 * @param {boolean} [o.includeFirstContactExtras] — property header + SMS footer trigger
 * @param {string} [o.propertyDisplayName]
 * @param {boolean} [o.applyTelegramReceiptMarkdown] — bold Ref # lines (default true)
 * @returns {{ body: string, parseMode: string | null, meta: object }}
 */
function renderForChannel(o) {
  const transportChannel = String(o.transportChannel || "").toLowerCase();
  let text = String(o.body || "").trim();
  const audience = String(o.audience || "unknown").toLowerCase();
  const includeFirstContactExtras = !!o.includeFirstContactExtras;
  const propertyDisplayName = String(o.propertyDisplayName || "").trim();
  const applyTelegramReceiptMarkdown =
    o.applyTelegramReceiptMarkdown !== false;

  const meta = {
    channelRender: true,
    transport: transportChannel,
    propertyHeader: false,
    smsComplianceFooter: false,
    telegramMarkdown: false,
  };

  if (!text || audience !== "tenant" || transportChannel === "portal") {
    return { body: text, parseMode: null, meta: { ...meta, channelRender: false } };
  }

  if (includeFirstContactExtras && propertyDisplayName) {
    const header = buildPropertyHeaderLine(propertyDisplayName);
    if (header) {
      text = `${header}\n\n${text}`;
      meta.propertyHeader = true;
    }
  }

  if (transportChannel === "sms" && includeFirstContactExtras) {
    text = `${text}\n\n${SMS_COMPLIANCE_FOOTER}`;
    meta.smsComplianceFooter = true;
  }

  if (transportChannel === "telegram") {
    if (applyTelegramReceiptMarkdown) {
      text = applyTelegramMarkdown(text);
      meta.telegramMarkdown = true;
      return { body: text, parseMode: "Markdown", meta };
    }
    return { body: text, parseMode: null, meta };
  }

  return { body: text, parseMode: null, meta };
}

module.exports = {
  renderForChannel,
  applyTelegramMarkdown,
  buildPropertyHeaderLine,
  SMS_COMPLIANCE_FOOTER,
};
