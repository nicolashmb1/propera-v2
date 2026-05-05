/**
 * Who is this phone? STAFF vs TENANT vs UNKNOWN (VENDOR later).
 * Data: contacts + staff + staff_assignments (+ properties).
 * Telegram `TG:…` queries resolve roster phone via `telegram_chat_link` when present.
 */
const { getSupabase } = require("../db/supabase");
const {
  getLinkedPhoneE164ForTelegramInbound,
} = require("../dal/telegramChatLinkLookup");
const { normalizePhoneE164 } = require("../utils/phone");
const {
  normalizeTelegramActorKeyForStaff,
} = require("../utils/telegramActor");

/**
 * @returns {Promise<{
 *   phoneE164: string,
 *   lane: 'STAFF'|'TENANT'|'UNKNOWN',
 *   contact: object|null,
 *   staff: object|null,
 *   assignments: Array<{ property_code: string, role: string, display_name: string }>,
 *   reason: string
 * }>}
 */
async function resolveActor(phoneRaw) {
  const raw = String(phoneRaw || "").trim();
  const sb = getSupabase();

  if (!sb) {
    const fallback =
      normalizeTelegramActorKeyForStaff(raw) || normalizePhoneE164(raw);
    return {
      phoneE164: fallback || "",
      lane: "UNKNOWN",
      contact: null,
      staff: null,
      assignments: [],
      reason: "db_not_configured",
    };
  }

  let lookupKey = "";
  const tgKey = normalizeTelegramActorKeyForStaff(raw);
  if (tgKey) {
    const digits = tgKey.replace(/^TG:/i, "").replace(/\D/g, "");
    const linked = await getLinkedPhoneE164ForTelegramInbound(sb, {
      telegramUserIdDigits: digits,
      telegramChatId: "",
    });
    lookupKey = linked
      ? normalizePhoneE164(linked) || String(linked).trim()
      : tgKey;
  } else {
    lookupKey = normalizePhoneE164(raw);
  }

  if (!lookupKey) {
    return {
      phoneE164: "",
      lane: "UNKNOWN",
      contact: null,
      staff: null,
      assignments: [],
      reason: "empty_phone",
    };
  }

  const phoneE164 = lookupKey;

  const { data: contact, error: cErr } = await sb
    .from("contacts")
    .select("id, phone_e164, display_name, preferred_lang")
    .eq("phone_e164", phoneE164)
    .maybeSingle();

  if (cErr) {
    return {
      phoneE164,
      lane: "UNKNOWN",
      contact: null,
      staff: null,
      assignments: [],
      reason: "db_error_contact:" + cErr.message,
    };
  }

  if (!contact) {
    return {
      phoneE164,
      lane: "TENANT",
      contact: null,
      staff: null,
      assignments: [],
      reason: "no_contact_row_default_tenant",
    };
  }

  const { data: staff, error: sErr } = await sb
    .from("staff")
    .select("id, contact_id, staff_id, display_name, role")
    .eq("contact_id", contact.id)
    .maybeSingle();

  if (sErr) {
    return {
      phoneE164,
      lane: "UNKNOWN",
      contact,
      staff: null,
      assignments: [],
      reason: "db_error_staff:" + sErr.message,
    };
  }

  if (!staff) {
    return {
      phoneE164,
      lane: "TENANT",
      contact,
      staff: null,
      assignments: [],
      reason: "contact_not_staff",
    };
  }

  const { data: rows, error: aErr } = await sb
    .from("staff_assignments")
    .select("property_code, role")
    .eq("staff_id", staff.id);

  if (aErr) {
    return {
      phoneE164,
      lane: "STAFF",
      contact,
      staff,
      assignments: [],
      reason: "db_error_assignments:" + aErr.message,
    };
  }

  const codes = (rows || []).map((r) => r.property_code).filter(Boolean);
  let propNames = {};
  if (codes.length > 0) {
    const { data: props } = await sb
      .from("properties")
      .select("code, display_name")
      .in("code", codes);
    (props || []).forEach((p) => {
      propNames[p.code] = p.display_name || p.code;
    });
  }

  const assignments = (rows || []).map((r) => ({
    property_code: r.property_code,
    role: r.role || "",
    property_display: propNames[r.property_code] || r.property_code,
  }));

  return {
    phoneE164,
    lane: "STAFF",
    contact,
    staff,
    assignments,
    reason: "staff_match",
  };
}

module.exports = { resolveActor };
