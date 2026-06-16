/**
 * Tenant portal payment instructions — read-only property config + Stripe URL builder.
 * No money flows through Propera.
 */
const { getSupabase } = require("../db/supabase");
const { getTenantAccountBalance } = require("./tenantAccountService");
const { computePaymentTotals } = require("./paymentFees");
const { buildPaymentUrl, currentMonthKey } = require("./buildPaymentUrl");
const {
  propertyStripeCheckoutEnabled,
  mapPropertyStripeSettings,
} = require("./propertyStripeConfig");

const PAYMENT_COLS =
  "code, display_name, display_name_short, zelle_handle, zelle_name, stripe_ach_payment_link, stripe_card_payment_link, tenant_pays_stripe_fees, stripe_secret_key_enc, stripe_webhook_secret_enc";

function propertyHasPaymentConfig(prop) {
  if (!prop) return false;
  const zelle = String(prop.zelle_handle || "").trim();
  const ach = String(prop.stripe_ach_payment_link || "").trim();
  const card = String(prop.stripe_card_payment_link || "").trim();
  const checkout = propertyStripeCheckoutEnabled(prop);
  return !!(zelle || ach || card || checkout);
}

/**
 * @param {{ propertyCode: string }} tenantCtx
 */
async function tenantPaymentsVisible(tenantCtx) {
  const sb = getSupabase();
  const code = String(tenantCtx?.propertyCode || "").trim().toUpperCase();
  if (!sb || !code) return false;

  const { data } = await sb.from("properties").select(PAYMENT_COLS).eq("code", code).maybeSingle();
  return propertyHasPaymentConfig(data);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ tenantId: string, unitId?: string, propertyCode: string, unitLabel?: string }} tenantCtx
 */
async function getTenantPaymentMethods(sb, tenantCtx) {
  const propertyCode = String(tenantCtx.propertyCode || "").trim().toUpperCase();
  const unitLabel = String(tenantCtx.unitLabel || "").trim();
  if (!propertyCode) return { ok: false, error: "missing_property_context" };

  const balance = await getTenantAccountBalance(sb, tenantCtx);
  if (!balance.ok) return balance;

  const { data: prop } = await sb
    .from("properties")
    .select(PAYMENT_COLS)
    .eq("code", propertyCode)
    .maybeSingle();

  if (!propertyHasPaymentConfig(prop)) {
    return {
      ok: true,
      configured: false,
      balanceAvailable: !!balance.available,
      balanceCents: balance.available ? balance.balanceCents ?? null : null,
    };
  }

  let tenantName = "";
  let email = "";
  let tenantPhone = String(tenantCtx.phone || "").trim();
  if (tenantCtx.tenantId) {
    const { data: roster } = await sb
      .from("tenant_roster")
      .select("resident_name, email, phone_e164")
      .eq("id", tenantCtx.tenantId)
      .maybeSingle();
    tenantName = String(roster?.resident_name || "").trim();
    email = String(roster?.email || "").trim().toLowerCase();
    const rosterPhone = String(roster?.phone_e164 || "").trim();
    if (rosterPhone) tenantPhone = rosterPhone;
  }

  const balanceCents =
    balance.available && balance.balanceCents != null
      ? Math.max(0, Math.round(Number(balance.balanceCents)))
      : 0;
  const rentCents =
    balance.rentCents != null && Number(balance.rentCents) > 0
      ? Math.round(Number(balance.rentCents))
      : 0;
  const feeBasisCents = balanceCents > 0 ? balanceCents : rentCents;
  const tenantPaysStripeFees = prop?.tenant_pays_stripe_fees !== false;
  const totals = computePaymentTotals(feeBasisCents, { tenantPaysStripeFees });

  const stripeCheckout = propertyStripeCheckoutEnabled(prop);
  const stripeSettings = mapPropertyStripeSettings(prop);

  const unitCode = unitLabel ? `${propertyCode}-${unitLabel}` : propertyCode;
  const month = currentMonthKey();
  const urlCommon = { email, unitCode, month };

  const stripeAchUrl = stripeCheckout
    ? null
    : buildPaymentUrl(prop?.stripe_ach_payment_link, {
        ...urlCommon,
        amountCents: totals.achTotalCents,
      });
  const stripeCardUrl = stripeCheckout
    ? null
    : buildPaymentUrl(prop?.stripe_card_payment_link, {
        ...urlCommon,
        amountCents: totals.cardTotalCents,
      });

  return {
    ok: true,
    configured: true,
    balanceAvailable: !!balance.available,
    propertyName:
      String(prop?.display_name_short || "").trim() ||
      String(prop?.display_name || "").trim() ||
      propertyCode,
    unitLabel,
    balanceCents: balance.available ? balance.balanceCents ?? null : null,
    rentBaseCents: totals.baseCents > 0 ? totals.baseCents : null,
    paymentAmountCents: totals.baseCents > 0 ? totals.baseCents : null,
    achTotalCents: totals.achTotalCents > 0 ? totals.achTotalCents : null,
    cardTotalCents: totals.cardTotalCents > 0 ? totals.cardTotalCents : null,
    tenantName: tenantName || null,
    tenantEmail: email || null,
    tenantPhone: tenantPhone || null,
    zelleHandle: String(prop?.zelle_handle || "").trim() || null,
    zelleName: String(prop?.zelle_name || "").trim() || null,
    stripeAchUrl,
    stripeCardUrl,
    stripeMode: stripeCheckout ? "checkout" : "link",
    stripeCheckoutEnabled: stripeCheckout,
    stripeWebhookConfigured: stripeSettings.stripeWebhookSecretConfigured,
    achFeeCents: totals.achFeeCents,
    cardFeeCents: totals.cardFeeCents,
    tenantPaysStripeFees: totals.tenantPaysStripeFees,
  };
}

module.exports = {
  tenantPaymentsVisible,
  getTenantPaymentMethods,
  propertyHasPaymentConfig,
};
