/**
 * Single identity resolver: transport facts → one canonical brain actor key.
 * Staff-specific lookups (contacts, channel links) live here only — not in core/DAL.
 *
 * @see PROPERA_GUARDRAILS.md — Signal → Brain; adapters normalize transport, identity resolves canonical.
 */
const { normalizePhoneE164 } = require("../utils/phone");
const {
  getLinkedPhoneE164ForTelegramInbound,
} = require("../dal/telegramChatLinkLookup");

/**
 * @param {object} o
 * @param {import("@supabase/supabase-js").SupabaseClient | null} o.sb
 * @param {Record<string, string | undefined>} o.routerParameter
 * @param {{ contact_id?: string, staff_id?: string } | null} o.staffRow
 * @param {string} o.transportActorKey — `_phoneE164` / `From` (e.g. `TG:…`, `whatsapp:…`, `+1…`)
 * @param {boolean} o.isStaff — from `resolveStaffContextFromRouterParameter`
 * @returns {Promise<string>}
 */
async function resolveCanonicalBrainActorKey(o) {
  const sb = o.sb;
  const routerParameter = o.routerParameter || {};
  const staffRow = o.staffRow || null;
  const transportActorKey = String(o.transportActorKey || "").trim();
  const isStaff = o.isStaff === true;

  if (!isStaff) {
    return canonicalForNonStaff(transportActorKey);
  }

  if (!sb) return transportActorKey;

  if (staffRow && staffRow.contact_id) {
    const { data: c } = await sb
      .from("contacts")
      .select("phone_e164")
      .eq("id", staffRow.contact_id)
      .maybeSingle();
    if (c && c.phone_e164) return String(c.phone_e164).trim();
  }

  const chatId = String(routerParameter._telegramChatId || "").trim();
  const raw = transportActorKey;
  const tgDigits = raw.replace(/^TG:/i, "").replace(/\D/g, "");
  if (tgDigits && /^TG:/i.test(raw)) {
    const bridged = await getLinkedPhoneE164ForTelegramInbound(sb, {
      telegramUserIdDigits: tgDigits,
      telegramChatId: chatId,
    });
    if (bridged) return String(bridged).trim();
  }

  if (staffRow && staffRow.staff_id) {
    return "STAFF:" + String(staffRow.staff_id).trim();
  }

  const n = normalizePhoneE164(raw);
  if (n) return n;
  return raw;
}

/**
 * Tenants / unknown actors: stable string without staff-only DB joins.
 * @param {string} transportActorKey
 * @returns {string}
 */
function canonicalForNonStaff(transportActorKey) {
  const raw = String(transportActorKey || "").trim();
  if (!raw) return "";
  if (/^TG:/i.test(raw)) return raw;
  const n = normalizePhoneE164(raw);
  return n || raw;
}

module.exports = {
  resolveCanonicalBrainActorKey,
  canonicalForNonStaff,
};
