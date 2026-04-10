/**
 * Staff detection for router parity with GAS isStaffSender_ + Telegram staffActorKey fallback.
 * @see ../../../25_STAFF_RESOLVER.gs — normalizeTelegramActorKeyForStaff_, isStaffSender_
 * @see ../../../16_ROUTER_ENGINE.gs — staffActorKey / _telegramChatId (~265–277)
 */
const { getSupabase } = require("../db/supabase");
const { normalizePhoneE164 } = require("../utils/phone");

/**
 * @param {string} raw
 * @returns {string} "" or "TG:<digits>"
 */
function normalizeTelegramActorKeyForStaff(raw) {
  const s = String(raw || "").trim();
  if (!/^TG:/i.test(s)) return "";
  const id = s.replace(/^TG:\s*/i, "").replace(/\D/g, "");
  return id ? "TG:" + id : "";
}

/**
 * @param {Record<string, string | undefined>} p — RouterParameter
 */
function computeRouterIdentityKeys(p) {
  const fromRaw = String((p && p.From) || "").trim();
  const chHint = String((p && p._channel) || "").trim().toUpperCase();
  const isTgActor = /^TG:/i.test(fromRaw) || chHint === "TELEGRAM";
  let phone = String((p && p._phoneE164) || "").trim();
  if (!phone) phone = fromRaw;
  const chatDigits = String((p && p._telegramChatId) || "").replace(/\D/g, "");
  return { isTgActor, phone, chatDigits };
}

/**
 * @param {object} sb — Supabase client
 * @param {string} lookupRaw
 * @returns {Promise<{ isStaff: boolean, staff: object | null }>}
 */
async function isStaffForLookupKey(sb, lookupRaw) {
  const tg = normalizeTelegramActorKeyForStaff(lookupRaw);
  const lookup = tg || normalizePhoneE164(lookupRaw);
  if (!lookup) return { isStaff: false, staff: null };

  const { data: contact, error: cErr } = await sb
    .from("contacts")
    .select("id")
    .eq("phone_e164", lookup)
    .maybeSingle();

  if (cErr || !contact) return { isStaff: false, staff: null };

  const { data: staff, error: sErr } = await sb
    .from("staff")
    .select("id, staff_id, display_name, role, active")
    .eq("contact_id", contact.id)
    .maybeSingle();

  if (sErr || !staff) return { isStaff: false, staff: null };
  if (staff.active === false) return { isStaff: false, staff: null };

  return { isStaff: true, staff };
}

/**
 * Async identity for router staff intercept (no lifecycle side effects).
 *
 * @param {Record<string, string | undefined>} parameter — RouterParameter / e.parameter
 * @returns {Promise<{
 *   staffActorKey: string,
 *   isStaff: boolean,
 *   reason: string,
 *   phoneForLog: string,
 *   staff: object | null
 * }>}
 */
async function resolveStaffContextFromRouterParameter(parameter) {
  const p = parameter || {};
  const { isTgActor, phone, chatDigits } = computeRouterIdentityKeys(p);

  const sb = getSupabase();
  if (!sb) {
    return {
      staffActorKey: phone,
      isStaff: false,
      reason: "db_not_configured",
      phoneForLog: phone,
      staff: null,
    };
  }

  let staffActorKey = phone;

  let r = await isStaffForLookupKey(sb, staffActorKey);
  if (r.isStaff) {
    return {
      staffActorKey: normalizeTelegramActorKeyForStaff(staffActorKey) || staffActorKey,
      isStaff: true,
      reason: "staff_match",
      phoneForLog: phone,
      staff: r.staff,
    };
  }

  if (isTgActor && chatDigits) {
    const alt = "TG:" + chatDigits;
    r = await isStaffForLookupKey(sb, alt);
    if (r.isStaff) {
      return {
        staffActorKey: alt,
        isStaff: true,
        reason: "staff_match_chat_key",
        phoneForLog: phone,
        staff: r.staff,
      };
    }
  }

  if (!isTgActor) {
    const n = normalizePhoneE164(phone);
    if (n && n !== phone) {
      r = await isStaffForLookupKey(sb, n);
      if (r.isStaff) {
        return {
          staffActorKey: n,
          isStaff: true,
          reason: "staff_match_normalized",
          phoneForLog: phone,
          staff: r.staff,
        };
      }
    }
  }

  const normalizedTg = normalizeTelegramActorKeyForStaff(staffActorKey);
  return {
    staffActorKey: normalizedTg || staffActorKey,
    isStaff: false,
    reason: "not_staff",
    phoneForLog: phone,
    staff: null,
  };
}

module.exports = {
  normalizeTelegramActorKeyForStaff,
  resolveStaffContextFromRouterParameter,
  computeRouterIdentityKeys,
};
