/**
 * Resident portal OTP auth — tenant_roster scoped by org.
 */
const crypto = require("crypto");
const { getSupabase } = require("../db/supabase");
const { normalizePhoneE164 } = require("../utils/phone");
const { sendTwilioMessage } = require("../outbound/twilioSendMessage");
const {
  tenantOtpTtlMinutes,
  tenantOtpMaxAttempts,
  tenantOtpRateLimitPer15Min,
  nodeEnv,
  tenantDevOtpBypass,
  tenantDevOtpCode,
} = require("../config/env");
const { signTenantToken } = require("./tenantJwt");
const {
  loadOrgBrandById,
  loadTenantSessionBrand,
  buildOtpMessage,
} = require("./tenantBrandResolve");

/** @type {Map<string, { count: number, resetAt: number }>} */
const otpRateByPhone = new Map();

function rateLimitKey(phone, orgId) {
  return `${orgId}:${phone}`;
}

function checkOtpRateLimit(phone, orgId) {
  const key = rateLimitKey(phone, orgId);
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const max = tenantOtpRateLimitPer15Min();
  let entry = otpRateByPhone.get(key);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs };
    otpRateByPhone.set(key, entry);
  }
  if (entry.count >= max) {
    const err = new Error("rate_limited");
    err.code = "RATE_LIMITED";
    throw err;
  }
  entry.count += 1;
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 999999));
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} phone
 * @param {string} orgId
 */
async function findRosterForOrg(sb, phone, orgId) {
  const { data: rows, error } = await sb
    .from("tenant_roster")
    .select(
      "id, property_code, unit_label, phone_e164, resident_name, active, portal_enabled"
    )
    .eq("phone_e164", phone)
    .eq("active", true);
  if (error || !rows?.length) return null;

  for (const row of rows) {
    const code = String(row.property_code || "").trim().toUpperCase();
    const { data: prop } = await sb
      .from("properties")
      .select("code, org_id, display_name, display_name_short")
      .eq("code", code)
      .maybeSingle();
    if (!prop) continue;
    if (String(prop.org_id || "").trim() !== String(orgId || "").trim()) continue;
    if (row.portal_enabled === false) {
      const err = new Error("portal_disabled");
      err.code = "PORTAL_ACCESS_DENIED";
      throw err;
    }
    return { row, prop };
  }
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ row: object, prop: object }} match
 * @param {string} org
 * @param {string} phone
 */
async function issueTokenFromRosterMatch(sb, match, org, phone) {
  const propertyCode = String(match.row.property_code || "").trim().toUpperCase();
  const unitLabel = String(match.row.unit_label || "").trim();
  let unitId = "";
  const { data: unit } = await sb
    .from("units")
    .select("id")
    .eq("property_code", propertyCode)
    .eq("unit_label", unitLabel)
    .maybeSingle();
  if (unit) unitId = String(unit.id);

  const token = signTenantToken({
    tenantId: String(match.row.id),
    unitId,
    propertyCode,
    unitLabel,
    orgId: org,
    phone,
  });

  return {
    token,
    tenant: {
      id: String(match.row.id),
      name: String(match.row.resident_name || "").trim(),
      unitLabel,
      propertyDisplayName: String(match.prop.display_name || propertyCode).trim(),
    },
  };
}

/**
 * @param {string} phoneRaw
 * @param {string} orgId
 * @param {string} [traceId]
 */
async function requestOtp(phoneRaw, orgId, traceId) {
  const sb = getSupabase();
  if (!sb) {
    const err = new Error("no_db");
    err.code = "NO_DB";
    throw err;
  }

  const phone = normalizePhoneE164(phoneRaw);
  if (!phone) {
    const err = new Error("invalid_phone");
    err.code = "INVALID_PHONE";
    throw err;
  }

  const org = String(orgId || "").trim();
  if (!org) {
    const err = new Error("org_required");
    err.code = "ORG_REQUIRED";
    throw err;
  }

  if (!tenantDevOtpBypass()) {
    checkOtpRateLimit(phone, org);
  }

  const match = await findRosterForOrg(sb, phone, org);
  if (!match) {
    const err = new Error("tenant_not_found");
    err.code = "TENANT_NOT_FOUND";
    throw err;
  }

  const brand = await loadOrgBrandById(sb, org);
  const brandPreview = {
    orgBrandName: brand?.orgBrandName || "",
    orgBrandShort: brand?.orgBrandShort || "",
    propertyDisplayName: String(match.prop.display_name || "").trim(),
    propertyDisplayNameShort: String(match.prop.display_name_short || "").trim(),
    showProperaAttribution: brand?.showProperaAttribution !== false,
  };

  if (tenantDevOtpBypass()) {
    const devCode = tenantDevOtpCode();
    console.warn(
      `[tenant-otp] DEV BYPASS enabled — use code ${devCode} for ${phone} (no SMS)`
    );
    return {
      success: true,
      brandPreview,
      devBypass: true,
      devCode,
    };
  }

  await sb
    .from("tenant_otp_codes")
    .update({ used: true })
    .eq("phone_e164", phone)
    .eq("used", false);

  const code = generateOtpCode();
  const expiresAt = new Date(
    Date.now() + tenantOtpTtlMinutes() * 60 * 1000
  ).toISOString();

  const { error: insErr } = await sb.from("tenant_otp_codes").insert({
    phone_e164: phone,
    code,
    expires_at: expiresAt,
    used: false,
    attempts: 0,
  });
  if (insErr) {
    const err = new Error(insErr.message);
    err.code = "OTP_INSERT_FAILED";
    throw err;
  }

  const smsBody = buildOtpMessage(code, {
    orgBrandShort: brand?.orgBrandShort || "Portal",
    showProperaAttribution: brand?.showProperaAttribution !== false,
  });

  const sms = await sendTwilioMessage({
    to: phone,
    body: smsBody,
    channel: "sms",
    traceId,
  });

  if (nodeEnv !== "production" && !sms.ok) {
    console.error(
      `[tenant-otp] SMS not sent (${sms.error}); dev code for ${phone}: ${code}`
    );
  }

  const out = { success: true, brandPreview };
  if (nodeEnv !== "production" && !sms.ok) {
    out.devCode = code;
    out.devBypass = true;
  }
  return out;
}

/**
 * @param {string} phoneRaw
 * @param {string} codeRaw
 * @param {string} orgId
 */
async function verifyOtp(phoneRaw, codeRaw, orgId) {
  const sb = getSupabase();
  if (!sb) {
    const err = new Error("no_db");
    err.code = "NO_DB";
    throw err;
  }

  const phone = normalizePhoneE164(phoneRaw);
  const code = String(codeRaw || "").trim();
  if (!phone || !/^\d{6}$/.test(code)) {
    const err = new Error("invalid_input");
    err.code = "OTP_INVALID";
    throw err;
  }

  const org = String(orgId || "").trim();
  if (!org) {
    const err = new Error("org_required");
    err.code = "ORG_REQUIRED";
    throw err;
  }

  if (tenantDevOtpBypass() && code === tenantDevOtpCode()) {
    const match = await findRosterForOrg(sb, phone, org);
    if (!match) {
      const err = new Error("tenant_not_found");
      err.code = "TENANT_NOT_FOUND";
      throw err;
    }
    return issueTokenFromRosterMatch(sb, match, org, phone);
  }

  const { data: otpRow, error } = await sb
    .from("tenant_otp_codes")
    .select("id, code, expires_at, used, attempts")
    .eq("phone_e164", phone)
    .eq("used", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !otpRow) {
    const err = new Error("otp_expired");
    err.code = "OTP_EXPIRED";
    throw err;
  }

  if (new Date(otpRow.expires_at).getTime() < Date.now()) {
    await sb.from("tenant_otp_codes").update({ used: true }).eq("id", otpRow.id);
    const err = new Error("otp_expired");
    err.code = "OTP_EXPIRED";
    throw err;
  }

  const attempts = (otpRow.attempts || 0) + 1;
  if (attempts > tenantOtpMaxAttempts()) {
    await sb
      .from("tenant_otp_codes")
      .update({ used: true, attempts })
      .eq("id", otpRow.id);
    const err = new Error("max_attempts");
    err.code = "OTP_MAX_ATTEMPTS";
    throw err;
  }

  if (!timingSafeEqual(otpRow.code, code)) {
    await sb
      .from("tenant_otp_codes")
      .update({ attempts })
      .eq("id", otpRow.id);
    const err = new Error("otp_invalid");
    err.code = "OTP_INVALID";
    throw err;
  }

  await sb
    .from("tenant_otp_codes")
    .update({ used: true, attempts })
    .eq("id", otpRow.id);

  const match = await findRosterForOrg(sb, phone, org);
  if (!match) {
    const err = new Error("tenant_not_found");
    err.code = "TENANT_NOT_FOUND";
    throw err;
  }

  return issueTokenFromRosterMatch(sb, match, org, phone);
}

module.exports = {
  requestOtp,
  verifyOtp,
  findRosterForOrg,
  buildOtpMessage,
  loadTenantSessionBrand,
};
