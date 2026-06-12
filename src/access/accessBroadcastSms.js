const { getBrandContext } = require("../communication/brandContextService");
const { appendFooter } = require("../communication/messageComposer");
const {
  twilioBroadcastFrom,
  commBroadcastFooterMainNumber,
  communicationOrgId,
} = require("../config/env");

/**
 * Tenant amenity SMS uses the Communication Engine broadcast number + footer.
 * @param {object} o
 * @param {string} o.bodyText
 * @param {string} [o.propertyCode]
 * @param {string} [o.orgId]
 */
async function buildAccessBroadcastSmsBody(o) {
  const bodyText = String(o.bodyText || "").trim();
  const propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  const orgId = String(o.orgId || communicationOrgId()).trim();
  const brandContext = await getBrandContext({
    orgId,
    propertyCodes: propertyCode ? [propertyCode] : [],
  });
  return appendFooter(
    bodyText,
    brandContext,
    propertyCode,
    commBroadcastFooterMainNumber(),
    "en"
  );
}

function accessBroadcastSmsFrom() {
  return twilioBroadcastFrom();
}

module.exports = {
  buildAccessBroadcastSmsBody,
  accessBroadcastSmsFrom,
};
