/**
 * Rent-reminder SMS compose + preview — uses org templates + Communication Engine footer.
 */

const { draftMessage, appendFooter, estimateSmsSegments } = require("./messageComposer");
const { getBrandContext } = require("./brandContextService");

function normalizeWrapText(raw) {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function previewBalanceReminderMessage(orgId, input) {
  const opts = input && typeof input === "object" ? input : {};
  const messageBody = normalizeWrapText(opts.messageBody || opts.message_body || "");
  if (!messageBody) return { ok: false, error: "missing_message_body" };

  const propertyCode = String(opts.propertyCode || opts.property_code || "")
    .trim()
    .toUpperCase();
  const propertyCodes = propertyCode ? [propertyCode] : [];
  const isMultiProperty = !propertyCode;

  const brandContext = await getBrandContext({ orgId, propertyCodes });
  const language = String(opts.language || "en").trim().toLowerCase() || "en";

  const finalBody = appendFooter(messageBody, brandContext, propertyCode, "", language, {
    isMultiProperty,
  });
  const smsEstimate = estimateSmsSegments(finalBody);

  const propertyCtx = propertyCode && brandContext.properties ? brandContext.properties[propertyCode] : null;
  const signOffLabel =
    (propertyCtx && propertyCtx.senderLabel) ||
    String(brandContext.orgBrandShort || brandContext.orgBrandName || "Management").trim();

  return {
    ok: true,
    previewMessage: {
      body: finalBody,
      baseBody: messageBody,
      signOffLabel,
      propertyCode: propertyCode || null,
      smsEstimate,
    },
  };
}

async function draftBalanceReminderMessage(orgId, input) {
  const opts = input && typeof input === "object" ? input : {};
  const brief = normalizeWrapText(opts.brief || "");
  if (!brief) return { ok: false, error: "missing_brief" };

  const brandContext = await getBrandContext({ orgId, propertyCodes: [] });
  const deliveryMode = String(opts.deliveryMode || opts.delivery_mode || "sms_only").trim().toLowerCase();

  const drafted = await draftMessage({
    brief,
    commType: "LEASE_ADMIN",
    tone: String(opts.tone || "professional").trim().toLowerCase() || "professional",
    language: String(opts.language || "en").trim().toLowerCase() || "en",
    brandContext,
    audienceLabel: "residents with an outstanding balance",
    deliveryMode,
  });
  if (!drafted.ok) return drafted;

  return {
    ok: true,
    draft: {
      body: normalizeWrapText(drafted.body),
      aiAssisted: drafted.aiAssisted === true,
      warning: drafted.warning || undefined,
    },
  };
}

/** Preview org SMS templates (Organization settings). */
async function previewOrgBroadcastSms(orgId, input) {
  const opts = input && typeof input === "object" ? input : {};
  const sampleBody = normalizeWrapText(
    opts.messageBody ||
      opts.message_body ||
      "Sample reminder: your rent balance is outstanding. Please pay promptly."
  );
  return previewBalanceReminderMessage(orgId, {
    messageBody: sampleBody,
    propertyCode: opts.propertyCode ?? opts.property_code,
    language: opts.language || "en",
  });
}

module.exports = {
  normalizeWrapText,
  previewBalanceReminderMessage,
  draftBalanceReminderMessage,
  previewOrgBroadcastSms,
};
