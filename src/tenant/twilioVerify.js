/**
 * Twilio Verify adapter for tenant OTP — no 10DLC campaign registration needed.
 * Enabled when TWILIO_VERIFY_SERVICE_SID is set in env.
 *
 * Drop-in replacement for the custom tenant_otp_codes path in authService.js.
 * When TWILIO_VERIFY_SERVICE_SID is not set, returns { ok: false } and the
 * caller falls back to the existing custom OTP path.
 */

const { twilioAccountSid, twilioAuthToken, nodeEnv } = require("../config/env");

function verifyServiceSid() {
  return String(process.env.TWILIO_VERIFY_SERVICE_SID || "").trim();
}

function isVerifyEnabled() {
  return !!(verifyServiceSid() && twilioAccountSid() && twilioAuthToken());
}

function verifyBaseUrl() {
  return `https://verify.twilio.com/v2/Services/${verifyServiceSid()}`;
}

function authHeader() {
  const sid = twilioAccountSid();
  const token = twilioAuthToken();
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

/** Map Twilio API message to a stable client error code. */
function classifyVerifySendError(message) {
  const m = String(message || "").toLowerCase();
  if (m.includes("trial") && m.includes("unverified")) {
    return "sms_trial_unverified";
  }
  if (m.includes("not a valid phone") || m.includes("invalid 'to'")) {
    return "sms_invalid_number";
  }
  return "sms_failed";
}

/**
 * Cancel a pending verification so a resend issues a new code.
 * @param {string} verificationSid — VE…
 */
async function cancelVerifyOtp(verificationSid) {
  if (!isVerifyEnabled()) return { ok: false, error: "verify_not_configured" };

  const sid = String(verificationSid || "").trim();
  if (!/^VE[a-f0-9]{32}$/i.test(sid)) return { ok: true, skipped: true };

  try {
    const res = await fetch(`${verifyBaseUrl()}/Verifications/${sid}`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Status: "canceled" }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 404) {
      const msg = data.message || String(res.status);
      if (nodeEnv !== "production") {
        console.warn("[twilio-verify] cancel failed:", msg);
      }
      return { ok: false, error: String(msg).slice(0, 200) };
    }
    if (nodeEnv !== "production") {
      console.warn(`[twilio-verify] canceled ${sid}`);
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[twilio-verify] cancel error:", msg);
    return { ok: false, error: msg.slice(0, 200) };
  }
}

/**
 * Send OTP via Twilio Verify.
 * @param {string} phoneE164
 * @param {{ cancelVerificationSid?: string }} [opts] — cancel prior session before resend
 * @returns {Promise<{ ok: boolean, verificationSid?: string, error?: string }>}
 */
async function sendVerifyOtp(phoneE164, opts) {
  if (!isVerifyEnabled()) return { ok: false, error: "verify_not_configured" };

  const cancelSid = String(opts?.cancelVerificationSid || "").trim();
  if (cancelSid) {
    await cancelVerifyOtp(cancelSid);
  }

  try {
    const res = await fetch(`${verifyBaseUrl()}/Verifications`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phoneE164, Channel: "sms" }).toString(),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data.message || data.code || String(res.status);
      console.error("[twilio-verify] send failed:", msg);
      return {
        ok: false,
        error: String(msg).slice(0, 200),
        errorCode: classifyVerifySendError(msg),
      };
    }

    const verificationSid = String(data.sid || "").trim();
    if (nodeEnv !== "production") {
      console.warn(
        `[twilio-verify] sent to ${phoneE164} status=${data.status || "?"} sid=${verificationSid || "(none)"}`
      );
    }
    return { ok: true, verificationSid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[twilio-verify] send error:", msg);
    return { ok: false, error: msg.slice(0, 200) };
  }
}

/**
 * Check OTP via Twilio Verify.
 * @param {string} phoneE164 — fallback when verificationSid omitted
 * @param {string} code — 6-digit code the tenant entered
 * @param {string} [verificationSid] — VE… from send response (preferred)
 * @returns {Promise<{ ok: boolean, approved: boolean, error?: string }>}
 */
async function checkVerifyOtp(phoneE164, code, verificationSid) {
  if (!isVerifyEnabled()) return { ok: false, approved: false, error: "verify_not_configured" };

  const sid = String(verificationSid || "").trim();
  const params = { Code: String(code || "").trim() };
  if (/^VE[a-f0-9]{32}$/i.test(sid)) {
    params.VerificationSid = sid;
  } else if (phoneE164) {
    params.To = phoneE164;
  } else {
    return { ok: false, approved: false, error: "missing_verification_target" };
  }

  try {
    // Twilio link is …/VerificationCheck (singular) — /VerificationChecks returns 404 always
    const res = await fetch(`${verifyBaseUrl()}/VerificationCheck`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 404) {
        if (nodeEnv !== "production") {
          console.warn("[twilio-verify] check 404 — no pending verification (resend or expired?)");
        }
        return { ok: true, approved: false, error: "otp_expired" };
      }
      const msg = data.message || String(res.status);
      console.error("[twilio-verify] check failed:", msg);
      return { ok: false, approved: false, error: String(msg).slice(0, 200) };
    }

    const status = String(data.status || "").toLowerCase();
    if (nodeEnv !== "production") {
      console.warn(
        `[twilio-verify] check status=${status} valid=${data.valid} sid=${sid ? "yes" : "no"}`
      );
    }
    if (status === "approved") return { ok: true, approved: true };
    if (status === "max_attempts_reached") {
      return { ok: true, approved: false, error: "otp_max_attempts" };
    }
    if (status === "canceled") {
      return { ok: true, approved: false, error: "otp_expired" };
    }
    return { ok: true, approved: false, error: "otp_invalid" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[twilio-verify] check error:", msg);
    return { ok: false, approved: false, error: msg.slice(0, 200) };
  }
}

module.exports = { isVerifyEnabled, cancelVerifyOtp, sendVerifyOtp, checkVerifyOtp };
