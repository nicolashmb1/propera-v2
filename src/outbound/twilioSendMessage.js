/**
 * Twilio REST API outbound — SMS or WhatsApp (transport only).
 */
const {
  twilioAccountSid,
  twilioAuthToken,
  twilioSmsFrom,
  twilioWhatsappFrom,
  twilioOutboundEnabled,
} = require("../config/env");
const { emit } = require("../logging/structuredLog");

const API_BASE = "https://api.twilio.com/2010-04-01";

/**
 * @param {{ to: string, body: string, traceId?: string | null, channel: 'sms' | 'whatsapp' }} opts
 */
async function sendTwilioMessage(opts) {
  if (!twilioOutboundEnabled()) {
    return { ok: false, error: "twilio_outbound_disabled" };
  }
  const sid = twilioAccountSid();
  const token = twilioAuthToken();
  if (!sid || !token) {
    return { ok: false, error: "no_twilio_credentials" };
  }

  const ch = opts.channel === "whatsapp" ? "whatsapp" : "sms";
  const from =
    ch === "whatsapp" ? twilioWhatsappFrom() : twilioSmsFrom();
  if (!from) {
    return { ok: false, error: "no_twilio_from_number" };
  }

  let to = String(opts.to || "").trim();
  if (!to) return { ok: false, error: "missing_to" };
  if (ch === "whatsapp" && to.toLowerCase().indexOf("whatsapp:") !== 0) {
    to = "whatsapp:" + to.replace(/^\+/, "+");
  }

  const body = String(opts.body || "").trim();
  if (!body) return { ok: false, error: "missing_body" };

  const url = `${API_BASE}/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const form = new URLSearchParams();
  form.set("From", from);
  form.set("To", to);
  form.set("Body", body);

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : "fetch_failed";
    emit({
      level: "error",
      trace_id: opts.traceId || null,
      log_kind: "twilio_outbound",
      event: "send_failed",
      data: { error: msg },
    });
    return { ok: false, error: msg };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc =
      data && data.message ? String(data.message) : res.statusText || "twilio_error";
    emit({
      level: "warn",
      trace_id: opts.traceId || null,
      log_kind: "twilio_outbound",
      event: "send_rejected",
      data: { status: res.status, description: desc },
    });
    return { ok: false, error: desc };
  }

  emit({
    level: "info",
    trace_id: opts.traceId || null,
    log_kind: "twilio_outbound",
    event: "sent",
    data: { channel: ch, sid: data.sid || null },
  });
  return { ok: true, sid: data.sid || null };
}

module.exports = { sendTwilioMessage };
