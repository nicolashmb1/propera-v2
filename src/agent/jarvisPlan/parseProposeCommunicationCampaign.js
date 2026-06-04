/**
 * Portal typed-mode parser for tenant broadcast proposals (Jarvis Plan).
 */

const { readPortalPageContext } = require("../contextEnvelope");

const COMM_TRIGGER_RE =
  /^(?:send|broadcast|message|notify|text)\s+(?:a\s+)?(?:message\s+|notice\s+|sms\s+)?(?:to\s+)?(.+)$/i;

const BRIEF_SPLIT_RE = /\s+(?:that|about|to tell them|saying|to say)\s+/i;

/**
 * @param {string} remainder
 */
function splitAudienceAndBrief(remainder) {
  const r = String(remainder || "").trim();
  const m = r.match(BRIEF_SPLIT_RE);
  if (m && m.index != null && m.index > 0) {
    return {
      audiencePhrase: r.slice(0, m.index).trim(),
      brief: r.slice(m.index + m[0].length).trim(),
    };
  }
  return { audiencePhrase: r, brief: "" };
}

/**
 * @param {string} audiencePhrase
 * @param {object} page
 */
function parseAudiencePhrase(audiencePhrase, page) {
  const a = String(audiencePhrase || "").trim();
  const lower = a.toLowerCase();

  if (
    /\b(all properties|every property|portfolio|everyone|all tenants everywhere|all buildings)\b/.test(
      lower
    )
  ) {
    return { audienceScope: "portfolio", briefTail: "" };
  }

  const floorM = a.match(/\bfloor\s+(\d+[A-Za-z]?)\s+(?:at|in|@)\s+(.+)$/i);
  if (floorM) {
    return {
      audienceScope: "floor",
      floor: String(floorM[1] || "").trim(),
      propertyHint: String(floorM[2] || "").trim(),
    };
  }

  const tenantM = a.match(
    /\btenant\s+(.+?)\s+(?:in|at)\s+unit\s+#?(\d+[A-Za-z]?)\s+(?:at|in|@)\s+(.+)$/i
  );
  if (tenantM) {
    return {
      audienceScope: "tenant",
      tenantName: String(tenantM[1] || "").trim(),
      unitLabel: String(tenantM[2] || "").trim(),
      propertyHint: String(tenantM[3] || "").trim(),
    };
  }

  const unitM = a.match(/\bunit\s+#?(\d+[A-Za-z]?)\s+(?:at|in|@)\s+(.+)$/i);
  if (unitM) {
    return {
      audienceScope: "unit",
      unitLabel: String(unitM[1] || "").trim(),
      propertyHint: String(unitM[2] || "").trim(),
    };
  }

  const propM = a.match(
    /\b(?:all tenants|every tenant|all residents|everyone)\s+(?:at|in|@)\s+(.+)$/i
  );
  if (propM) {
    return {
      audienceScope: "property",
      propertyHint: String(propM[1] || "").trim(),
    };
  }

  const pinnedProperty = String(page?.property_code || page?.propertyCode || "").trim();
  if (pinnedProperty && /\b(all tenants|every tenant|everyone here)\b/.test(lower)) {
    return { audienceScope: "property", propertyHint: pinnedProperty };
  }

  return null;
}

/**
 * @param {string} body
 * @param {Record<string, string | undefined>} routerParameter
 * @returns {object | null}
 */
function parseProposeCommunicationCampaign(body, routerParameter) {
  const b = String(body || "").trim();
  if (!b || b.length < 12 || /\$\$/.test(b)) return null;

  const trigger = b.match(COMM_TRIGGER_RE);
  if (!trigger) return null;

  const page = readPortalPageContext(routerParameter || {});
  const { audiencePhrase, brief: briefFromSplit } = splitAudienceAndBrief(trigger[1]);
  const audience = parseAudiencePhrase(audiencePhrase, page);
  if (!audience) return null;

  let brief = briefFromSplit;
  if (!brief && audience.briefTail) brief = audience.briefTail;
  if (!brief || brief.length < 5) return null;

  return {
    kind: "send_communication_campaign",
    brief: brief.slice(0, 2000),
    audienceScope: audience.audienceScope,
    propertyHint: audience.propertyHint || String(page?.property_code || page?.propertyCode || ""),
    floor: audience.floor || "",
    unitLabel: audience.unitLabel || "",
    tenantName: audience.tenantName || "",
  };
}

module.exports = { parseProposeCommunicationCampaign, COMM_TRIGGER_RE };
