const { properaTimezone } = require("../config/env");

/**
 * @param {string} [timeZone]
 * @returns {string} YYYY-MM
 */
function currentMonthKey(timeZone) {
  const tz = String(timeZone || properaTimezone() || "UTC").trim() || "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    if (y && m) return `${y}-${m}`;
  } catch (_) {}
  return new Date().toISOString().slice(0, 7);
}

function isValidEmail(email) {
  const em = String(email || "").trim().toLowerCase();
  if (!em || em.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em);
}

/**
 * Append Stripe Payment Link query params from tenant portal context.
 * Official: locked_prefilled_email, client_reference_id (+ locale/UTM).
 * Best-effort: prefilled_amount (requires "Customers choose what to pay" link).
 * Name/phone cannot be prefilled on Payment Links — only via Checkout Sessions API.
 *
 * @param {string} baseUrl
 * @param {{ amountCents?: number, balanceCents?: number, email?: string, unitCode?: string, month?: string }} opts
 * @returns {string | null}
 */
function buildPaymentUrl(baseUrl, opts = {}) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const params = new URLSearchParams(url.search);
  const amountCents = Math.round(Number(opts.amountCents ?? opts.balanceCents) || 0);
  if (amountCents > 0) {
    params.set("prefilled_amount", String(amountCents));
  }

  const email = String(opts.email || "").trim().toLowerCase();
  if (isValidEmail(email)) {
    params.set("locked_prefilled_email", email);
  }

  const unitCode = String(opts.unitCode || "").trim();
  const month = String(opts.month || currentMonthKey()).trim();
  if (unitCode && month) {
    params.set("client_reference_id", `${unitCode}-${month}`);
  }

  const qs = params.toString();
  return qs ? `${url.origin}${url.pathname}?${qs}` : `${url.origin}${url.pathname}`;
}

module.exports = { buildPaymentUrl, currentMonthKey, isValidEmail };
