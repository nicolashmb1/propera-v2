const { computePaymentTotals } = require("./paymentFees");
const { createStripeClientForProperty, tenantPortalBaseUrl } = require("./stripeClient");
const { propertyStripeCheckoutEnabled } = require("./propertyStripeConfig");
const { currentMonthKey } = require("./buildPaymentUrl");

const PROP_COLS =
  "code, display_name, display_name_short, zelle_handle, zelle_name, stripe_ach_payment_link, stripe_card_payment_link, tenant_pays_stripe_fees, stripe_secret_key_enc, stripe_webhook_secret_enc";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ tenantId?: string, unitId?: string, propertyCode: string, unitLabel?: string, phone?: string }} tenantCtx
 * @param {{ method: 'ach' | 'card' }} opts
 * @param {import('express').Request} req
 */
async function createTenantCheckoutSession(sb, tenantCtx, opts, req) {
  const method = opts.method === "card" ? "card" : "ach";
  const propertyCode = String(tenantCtx.propertyCode || "").trim().toUpperCase();
  const unitLabel = String(tenantCtx.unitLabel || "").trim();
  if (!propertyCode) return { ok: false, error: "missing_property_context" };

  const { data: prop } = await sb.from("properties").select(PROP_COLS).eq("code", propertyCode).maybeSingle();
  if (!prop || !propertyStripeCheckoutEnabled(prop)) {
    return { ok: false, error: "stripe_checkout_not_configured", status: 400 };
  }

  const stripe = createStripeClientForProperty(prop);
  if (!stripe) return { ok: false, error: "stripe_checkout_not_configured", status: 400 };

  const balance = await require("./tenantAccountService").getTenantAccountBalance(sb, tenantCtx);
  if (!balance.ok) return balance;

  let tenantName = "";
  let email = "";
  if (tenantCtx.tenantId) {
    const { data: roster } = await sb
      .from("tenant_roster")
      .select("resident_name, email, phone_e164")
      .eq("id", tenantCtx.tenantId)
      .maybeSingle();
    tenantName = String(roster?.resident_name || "").trim();
    email = String(roster?.email || "").trim().toLowerCase();
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
  if (feeBasisCents <= 0) return { ok: false, error: "no_payment_amount", status: 400 };

  const tenantPaysStripeFees = prop.tenant_pays_stripe_fees !== false;
  const totals = computePaymentTotals(feeBasisCents, { tenantPaysStripeFees });
  const totalCents = method === "ach" ? totals.achTotalCents : totals.cardTotalCents;
  const feeCents = method === "ach" ? totals.achFeeCents : totals.cardFeeCents;
  const baseCents = totals.baseCents;

  const unitCode = unitLabel ? `${propertyCode}-${unitLabel}` : propertyCode;
  const month = currentMonthKey();
  const clientReferenceId = `${unitCode}-${month}`;
  const portalBase = tenantPortalBaseUrl(req);

  const lineItems = [
    {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: baseCents,
        product_data: {
          name: unitLabel ? `Rent — Unit ${unitLabel}` : `Rent — ${propertyCode}`,
        },
      },
    },
  ];
  if (feeCents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: feeCents,
        product_data: { name: "Processing fee" },
      },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: clientReferenceId,
    customer_email: email || undefined,
    payment_method_types: method === "ach" ? ["us_bank_account"] : ["card"],
    line_items: lineItems,
    success_url: `${portalBase}/tenant/pay?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${portalBase}/tenant/pay?stripe=canceled`,
    metadata: {
      property_code: propertyCode,
      unit_catalog_id: String(tenantCtx.unitId || ""),
      tenant_roster_id: String(tenantCtx.tenantId || ""),
      unit_label: unitLabel,
      month,
      payment_method: method,
      base_cents: String(baseCents),
      fee_cents: String(feeCents),
      total_cents: String(totalCents),
      tenant_name: tenantName,
    },
    payment_intent_data: {
      metadata: {
        property_code: propertyCode,
        unit_catalog_id: String(tenantCtx.unitId || ""),
        tenant_roster_id: String(tenantCtx.tenantId || ""),
        client_reference_id: clientReferenceId,
        payment_method: method,
        base_cents: String(baseCents),
      },
    },
  });

  const { data: row, error: insErr } = await sb
    .from("tenant_stripe_payments")
    .insert({
      property_code: propertyCode,
      unit_catalog_id: tenantCtx.unitId || null,
      tenant_roster_id: tenantCtx.tenantId || null,
      checkout_session_id: session.id,
      payment_intent_id: String(session.payment_intent || "") || null,
      payment_method: method,
      status: "pending",
      base_cents: baseCents,
      fee_cents: feeCents,
      total_cents: totalCents,
      client_reference_id: clientReferenceId,
    })
    .select("id")
    .maybeSingle();

  if (insErr) return { ok: false, error: insErr.message, status: 500 };

  return {
    ok: true,
    sessionId: session.id,
    url: session.url,
    paymentId: row?.id || null,
    method,
    baseCents,
    feeCents,
    totalCents,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ tenantId?: string, unitId?: string, propertyCode: string }} tenantCtx
 * @param {string} sessionId
 */
async function getTenantCheckoutPaymentStatus(sb, tenantCtx, sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return { ok: false, error: "missing_session_id", status: 400 };

  const { data: row } = await sb
    .from("tenant_stripe_payments")
    .select(
      "id, property_code, unit_catalog_id, tenant_roster_id, checkout_session_id, payment_intent_id, payment_method, status, base_cents, fee_cents, total_cents, client_reference_id, ledger_entry_id, failure_message, created_at, updated_at"
    )
    .eq("checkout_session_id", sid)
    .maybeSingle();

  if (!row) return { ok: false, error: "not_found", status: 404 };

  const propertyCode = String(tenantCtx.propertyCode || "").trim().toUpperCase();
  if (String(row.property_code || "").toUpperCase() !== propertyCode) {
    return { ok: false, error: "not_found", status: 404 };
  }
  if (tenantCtx.unitId && row.unit_catalog_id && String(row.unit_catalog_id) !== String(tenantCtx.unitId)) {
    return { ok: false, error: "not_found", status: 404 };
  }

  return {
    ok: true,
    payment: {
      sessionId: row.checkout_session_id,
      status: row.status,
      method: row.payment_method,
      baseCents: Number(row.base_cents),
      feeCents: Number(row.fee_cents),
      totalCents: Number(row.total_cents),
      clientReferenceId: row.client_reference_id,
      ledgerPosted: !!row.ledger_entry_id,
      failureMessage: row.failure_message || null,
      updatedAt: row.updated_at,
    },
  };
}

module.exports = {
  createTenantCheckoutSession,
  getTenantCheckoutPaymentStatus,
  PROP_COLS,
};
