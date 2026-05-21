/**
 * Deterministic expense text parsing for `$$` marker messages (no LLM).
 * @see docs/FINANCIAL_INTAKE_V1.md
 */

const HUMAN_ID_ANY = "([A-Za-z0-9]{2,12}-\\d{6}-\\d{4})";

const TENANT_CHARGE_ANCHOR_RE =
  /\b(?:tenant\s+charg(?:e|ed|ing)|charge(?:d)?\s+(?:the\s+)?tenant|bill\s+tenant|add\s+to\s+tenant\s+charges?|tenants?\s+(?:need|needs)\s+to\s+be\s+charged|chargeback)\b/gi;

const VENDOR_COST_ANCHOR_RE =
  /\b(?:door\s+cost|parts?\s+cost|material\s+cost|labor\s+cost|cost\s+of|paid|spent|from\s+home|homedepot|lowe'?s?)\b/gi;

const OFFICE_RECEIPT_RE = /\b(office\s+has\s+receipt|physical\s+receipt|paper\s+receipt)\b/i;

const VENDOR_ALIASES = [
  { re: /\b(home\s*depot|homedepot|home\s*depo)\b/i, name: "Home Depot" },
  { re: /\b(lowe'?s?)\b/i, name: "Lowe's" },
  { re: /\b(ace\s+hardware)\b/i, name: "Ace Hardware" },
];

/**
 * @param {string} body
 * @returns {boolean}
 */
function isExpenseCaptureMessage(body) {
  return /^\$\$\s*/i.test(String(body || "").trim());
}

/**
 * @param {string} body
 * @returns {string}
 */
function stripExpenseMarker(body) {
  return String(body || "")
    .trim()
    .replace(/^\$\$\s*/i, "")
    .trim();
}

/**
 * @param {string} body
 * @returns {string}
 */
function extractHumanTicketIdAnywhere(body) {
  const re = new RegExp(HUMAN_ID_ANY, "gi");
  const m = re.exec(String(body || ""));
  return m ? String(m[1] || "").trim().toUpperCase() : "";
}

/**
 * @param {string} raw
 * @returns {number | null}
 */
function dollarsToCents(raw) {
  const n = Number(String(raw || "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/**
 * All money-like tokens with index for dual vendor/tenant assignment.
 * @param {string} text
 * @returns {Array<{ cents: number, index: number, end: number }>}
 */
function findMoneyTokens(text) {
  const s = String(text || "");
  const seen = new Set();
  const out = [];

  function push(m, index, end) {
    const cents = dollarsToCents(m);
    if (!cents || seen.has(index)) return;
    seen.add(index);
    out.push({ cents, index, end: end != null ? end : index + String(m).length });
  }

  const patterns = [
    /\$\s*(\d{1,6}(?:\.\d{1,2})?)/gi,
    /\b(\d{1,4}\.\d{2})\b/g,
    /\b(\d{1,5})\s+dollars?\b/gi,
    /\btenant\s+charg(?:e|ed|ing)\s+(\d{1,5}(?:\.\d{1,2})?)\b/gi,
    /\bcharge(?:d)?\s+(?:the\s+)?tenant\s+(\d{1,5}(?:\.\d{1,2})?)\b/gi,
    /\b(?:parts?|labor|material|cost|door|service)\s+(\d{1,5}(?:\.\d{1,2})?)\b/gi,
    /\b(\d{1,5}(?:\.\d{1,2})?)\s+for\b/gi,
    /\b(\d{1,5})\s+and\b/gi,
    /\band\s+(\d{1,5}(?:\.\d{1,2})?)\b/gi,
    /,\s*(\d{1,5}(?:\.\d{1,2})?)\b/g,
  ];

  for (const re of patterns) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(s)) !== null) {
      const raw = m[1];
      if (!raw) continue;
      push(raw, m.index + m[0].indexOf(raw), m.index + m[0].length);
    }
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * @param {string} text
 * @param {RegExp} re
 * @returns {number}
 */
function nearestAnchorDistance(text, token, re) {
  const s = String(text || "");
  let best = Infinity;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const anchorMid = m.index + Math.floor(m[0].length / 2);
    const tokenMid = token.index + Math.floor((token.end - token.index) / 2);
    const d = Math.abs(anchorMid - tokenMid);
    if (d < best) best = d;
  }
  return best;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function hasTenantChargeIntent(text) {
  TENANT_CHARGE_ANCHOR_RE.lastIndex = 0;
  return TENANT_CHARGE_ANCHOR_RE.test(String(text || ""));
}

/** Max character distance from amount token to anchor for a confident split. */
const ANCHOR_CONFIDENT_MAX_DIST = 50;

/**
 * Two+ money tokens without clear vendor vs tenant assignment — force medium + confirm.
 * @param {string} text
 * @returns {boolean}
 */
function isAmbiguousAmountSplit(text) {
  const s = String(text || "");
  const tokens = findMoneyTokens(s);
  if (tokens.length < 2) return false;

  const tenantIntent = hasTenantChargeIntent(s);
  if (!tenantIntent) return true;

  for (const tok of tokens) {
    const dTenant = nearestAnchorDistance(s, tok, TENANT_CHARGE_ANCHOR_RE);
    const dVendor = nearestAnchorDistance(s, tok, VENDOR_COST_ANCHOR_RE);
    if (dTenant > ANCHOR_CONFIDENT_MAX_DIST && dVendor > ANCHOR_CONFIDENT_MAX_DIST) {
      return true;
    }
  }

  if (tokens.length === 2) {
    const scored = tokens.map((tok) => ({
      dTenant: nearestAnchorDistance(s, tok, TENANT_CHARGE_ANCHOR_RE),
      dVendor: nearestAnchorDistance(s, tok, VENDOR_COST_ANCHOR_RE),
    }));
    if (
      Math.min(scored[0].dTenant, scored[1].dTenant) > 40 &&
      Math.min(scored[0].dVendor, scored[1].dVendor) > 40
    ) {
      return true;
    }
  }

  return false;
}

/**
 * @param {string} text
 * @returns {{ vendorAmountCents: number, tenantChargeAmountCents: number | null }}
 */
function parseVendorAndTenantAmounts(text) {
  const s = String(text || "");
  const tokens = findMoneyTokens(s);
  const tenantIntent = hasTenantChargeIntent(s);

  if (!tokens.length) {
    return { vendorAmountCents: 0, tenantChargeAmountCents: null };
  }

  if (!tenantIntent) {
    const vendor = tokens[tokens.length - 1].cents;
    return { vendorAmountCents: vendor, tenantChargeAmountCents: null };
  }

  if (tokens.length === 1) {
    const only = tokens[0];
    const dTenant = nearestAnchorDistance(s, only, TENANT_CHARGE_ANCHOR_RE);
    const dVendor = nearestAnchorDistance(s, only, VENDOR_COST_ANCHOR_RE);
    if (dTenant <= dVendor) {
      return { vendorAmountCents: 0, tenantChargeAmountCents: only.cents };
    }
    return { vendorAmountCents: only.cents, tenantChargeAmountCents: null };
  }

  const scored = tokens.map((tok) => ({
    tok,
    dTenant: nearestAnchorDistance(s, tok, TENANT_CHARGE_ANCHOR_RE),
    dVendor: nearestAnchorDistance(s, tok, VENDOR_COST_ANCHOR_RE),
  }));

  let tenantTok = scored[0];
  let vendorTok = scored[1];
  if (scored.length >= 2) {
    const byTenant = [...scored].sort((a, b) => a.dTenant - b.dTenant);
    tenantTok = byTenant[0];
    const byVendor = [...scored]
      .filter((x) => x.tok.index !== tenantTok.tok.index)
      .sort((a, b) => a.dVendor - b.dVendor);
    vendorTok = byVendor[0] || scored.find((x) => x.tok.index !== tenantTok.tok.index) || tenantTok;
    if (tenantTok.tok.index === vendorTok.tok.index && scored.length >= 2) {
      vendorTok = scored[1];
      tenantTok = scored[0];
      if (tenantTok.dTenant > vendorTok.dTenant) {
        const swap = tenantTok;
        tenantTok = vendorTok;
        vendorTok = swap;
      }
    }
  }

  return {
    vendorAmountCents: vendorTok && vendorTok.tok.index !== tenantTok.tok.index ? vendorTok.tok.cents : 0,
    tenantChargeAmountCents: tenantTok.tok.cents,
  };
}

/**
 * First money amount in dollars → cents (legacy / simple messages).
 * @param {string} text
 * @returns {number | null}
 */
function parseAmountCents(text) {
  const { vendorAmountCents, tenantChargeAmountCents } = parseVendorAndTenantAmounts(text);
  if (vendorAmountCents > 0) return vendorAmountCents;
  if (tenantChargeAmountCents != null && tenantChargeAmountCents > 0) return tenantChargeAmountCents;
  return null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function inferEntryType(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(plumb|hvac|electrician|vendor|invoice|service\s*call)\b/.test(t)) {
    return "vendor_invoice";
  }
  if (/\b(labor|handyman|hours?)\b/.test(t)) return "labor";
  if (/\b(material|supplies?)\b/.test(t)) return "material";
  if (/\b(clean)\b/.test(t)) return "cleaning";
  if (/\b(permit)\b/.test(t)) return "permit";
  if (/\b(part|parts|vent|elbow|cap|filter|door)\b/.test(t)) return "parts";
  if (hasTenantChargeIntent(t) && !/\b(parts?|material|labor)\b/.test(t)) return "other";
  return "parts";
}

/**
 * @param {string} text
 * @returns {string}
 */
function inferVendorName(text) {
  const t = String(text || "");
  for (const { re, name } of VENDOR_ALIASES) {
    if (re.test(t)) return name;
  }
  const m = t.match(/\b(?:at|from)\s+([A-Za-z][A-Za-z0-9\s'-]{2,40})/i);
  if (m) return String(m[1] || "").trim().slice(0, 120);
  return "";
}

/**
 * @param {string} text
 * @returns {string}
 */
function inferTenantChargeReason(text) {
  const s = String(text || "");
  const m = s.match(
    /\b(?:tenant\s+charg(?:e|ed|ing)|charge(?:d)?\s+(?:the\s+)?tenant)\b[^.]{0,120}/i
  );
  if (!m) return "";
  let clause = String(m[0] || "")
    .replace(/\b(?:tenant\s+charg(?:e|ed|ing)|charge(?:d)?\s+(?:the\s+)?tenant)\b/gi, "")
    .replace(/(?:\$)\s*\d{1,6}(?:\.\d{1,2})?/g, "")
    .replace(/\b\d{1,5}(?:\.\d{1,2})?\s*dollars?\b/gi, "")
    .replace(/\b\d{1,5}(?:\.\d{1,2})?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  clause = clause.replace(/^(?:for|on|the)\s+/i, "").trim();
  return clause.slice(0, 500);
}

/**
 * @param {string} text
 * @returns {string}
 */
function inferDescription(text) {
  let s = String(text || "").trim();
  s = s.replace(new RegExp(HUMAN_ID_ANY, "gi"), "").trim();
  s = s.replace(/(?:\$)\s*\d{1,6}(?:\.\d{1,2})?/g, "").trim();
  s = s.replace(/\b\d{1,5}(?:\.\d{1,2})?\s*dollars?\b/gi, "").trim();
  for (const { re } of VENDOR_ALIASES) s = s.replace(re, "").trim();
  s = s.replace(/\b(apt|unit|apartment)\s+\d+[a-z]?\b/gi, "").trim();
  s = s.replace(
    /\b(?:tenant\s+charg(?:e|ed|ing)|charge(?:d)?\s+(?:the\s+)?tenant|bill\s+tenant|add\s+to\s+tenant\s+charges?)\b/gi,
    ""
  ).trim();
  s = s.replace(/\b(for|on)\b/gi, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 500) || "Maintenance cost";
}

/**
 * @param {string} text
 * @returns {"PHOTO_ATTACHED"|"OFFICE_HOLDS_PHYSICAL"|"MISSING"}
 */
function inferReceiptStatus(text, hasPhoto) {
  if (hasPhoto) return "PHOTO_ATTACHED";
  if (OFFICE_RECEIPT_RE.test(String(text || ""))) return "OFFICE_HOLDS_PHYSICAL";
  return "MISSING";
}

/**
 * @param {string} rawBody
 * @param {{ hasPhoto?: boolean }} [opts]
 */
function parseExpenseCaptureText(rawBody, opts) {
  const opts2 = opts || {};
  const body = stripExpenseMarker(rawBody);
  const amounts = parseVendorAndTenantAmounts(body);
  const tenantCents = amounts.tenantChargeAmountCents;
  const vendorCents = amounts.vendorAmountCents || 0;
  const hasTenantCharge = tenantCents != null && tenantCents > 0;

  const moneyTokens = findMoneyTokens(body);

  return {
    body,
    humanTicketId: extractHumanTicketIdAnywhere(body),
    amountCents: vendorCents > 0 ? vendorCents : hasTenantCharge ? 0 : null,
    vendorAmountCents: vendorCents,
    tenantChargeAmountCents: hasTenantCharge ? tenantCents : null,
    hasTenantCharge,
    amountSplitAmbiguous: isAmbiguousAmountSplit(body),
    moneyTokenCount: moneyTokens.length,
    entryType: inferEntryType(body),
    vendorName: inferVendorName(body),
    description: inferDescription(body),
    tenantChargeReason: inferTenantChargeReason(body) || inferDescription(body),
    receiptStatus: inferReceiptStatus(body, !!opts2.hasPhoto),
    /** @deprecated use hasTenantCharge */
    isChargeback: hasTenantCharge,
  };
}

module.exports = {
  isExpenseCaptureMessage,
  stripExpenseMarker,
  extractHumanTicketIdAnywhere,
  parseAmountCents,
  parseVendorAndTenantAmounts,
  findMoneyTokens,
  hasTenantChargeIntent,
  isAmbiguousAmountSplit,
  parseExpenseCaptureText,
};
