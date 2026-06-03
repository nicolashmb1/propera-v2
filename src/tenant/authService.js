/**
 * Resident portal OTP auth — tenant_roster scoped by org.
 */
const crypto = require("crypto");
const { getSupabase } = require("../db/supabase");
const { normalizePhoneE164, rosterPhoneLookupCandidates } = require("../utils/phone");
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
const { isVerifyEnabled, sendVerifyOtp, checkVerifyOtp } = require("./twilioVerify");

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

/** Normalize unit label for roster match (pilot QR identify). */
function normalizeUnitLabel(label) {
  return String(label || "").trim().toUpperCase();
}

/**
 * Match tenant by unit + phone at a specific property (org-scoped).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} phone
 * @param {string} unitLabel
 * @param {string} propertyCode
 * @param {string} orgId
 */
async function findRosterForOrgByUnitAndPhone(sb, phoneRaw, unitLabel, propertyCode, orgId) {
  const pc = String(propertyCode || "").trim().toUpperCase();
  const unitNorm = normalizeUnitLabel(unitLabel);
  if (!pc || !unitNorm) return null;

  const { data: prop } = await sb
    .from("properties")
    .select("code, org_id, display_name, display_name_short")
    .eq("code", pc)
    .maybeSingle();
  if (!prop || String(prop.org_id || "").trim() !== String(orgId || "").trim()) {
    return null;
  }

  const phoneCandidates = rosterPhoneLookupCandidates(phoneRaw);
  if (!phoneCandidates.length) return null;

  const { data: rows, error } = await sb
    .from("tenant_roster")
    .select(
      "id, property_code, unit_label, phone_e164, resident_name, active, portal_enabled"
    )
    .in("phone_e164", phoneCandidates)
    .eq("property_code", pc)
    .eq("active", true);
  if (error || !rows?.length) return null;

  const row = rows.find((r) => normalizeUnitLabel(r.unit_label) === unitNorm);
  if (!row) return null;
  if (row.portal_enabled === false) {
    const err = new Error("portal_disabled");
    err.code = "PORTAL_ACCESS_DENIED";
    throw err;
  }
  return { row, prop };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} phone
 * @param {string} orgId
 */
async function findRosterForOrg(sb, phoneRaw, orgId) {
  const phoneCandidates = rosterPhoneLookupCandidates(phoneRaw);
  if (!phoneCandidates.length) return null;

  const { data: rows, error } = await sb
    .from("tenant_roster")
    .select(
      "id, property_code, unit_label, phone_e164, resident_name, active, portal_enabled"
    )
    .in("phone_e164", phoneCandidates)
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
 * @param {string} [cancelVerificationSid] — Twilio VE… to cancel before resend
 */
async function requestOtp(phoneRaw, orgId, traceId, cancelVerificationSid) {
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

  if (isVerifyEnabled()) {
    const sent = await sendVerifyOtp(phone, {
      cancelVerificationSid: String(cancelVerificationSid || "").trim() || undefined,
    });
    if (!sent.ok) {
      const err = new Error(sent.error || "sms_failed");
      err.code = sent.errorCode || "SMS_FAILED";
      throw err;
    }
    return {
      success: true,
      brandPreview,
      via: "verify",
      verificationSid: sent.verificationSid || undefined,
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
 * @param {string} [verificationSid] — Twilio VE… from request-otp (Verify path)
 */
async function verifyOtp(phoneRaw, codeRaw, orgId, verificationSid) {
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

  if (isVerifyEnabled()) {
    const check = await checkVerifyOtp(phone, code, verificationSid);
    if (!check.ok) {
      const err = new Error(check.error || "otp_check_failed");
      err.code = "OTP_CHECK_FAILED";
      throw err;
    }
    if (!check.approved) {
      const errMap = {
        otp_expired: "OTP_EXPIRED",
        otp_max_attempts: "OTP_MAX_ATTEMPTS",
        otp_invalid: "OTP_INVALID",
      };
      const err = new Error(check.error || "otp_invalid");
      err.code = errMap[check.error] || "OTP_INVALID";
      throw err;
    }
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

/**
 * QR / door flow — no SMS OTP. Unit + phone must match roster at property.
 * @param {string} phoneRaw
 * @param {string} unitLabel
 * @param {string} propertyCode
 * @param {string} orgId
 */
async function identifyTenantByUnitAndPhone(phoneRaw, unitLabel, propertyCode, orgId) {
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

  checkOtpRateLimit(phone, org);

  const match = await findRosterForOrgByUnitAndPhone(
    sb,
    phone,
    unitLabel,
    propertyCode,
    org
  );
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
  identifyTenantByUnitAndPhone,
  findRosterForOrg,
  findRosterForOrgByUnitAndPhone,
  buildOtpMessage,
  loadTenantSessionBrand,
};
