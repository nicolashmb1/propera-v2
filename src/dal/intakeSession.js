/**
 * GAS Sessions sheet parity — `public.intake_sessions` (001_core.sql).
 */
const { getSupabase } = require("../db/supabase");

/**
 * @param {string} phoneE164
 * @returns {Promise<object | null>}
 */
async function getIntakeSession(phoneE164) {
  const key = String(phoneE164 || "").trim();
  if (!key) return null;
  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from("intake_sessions")
    .select(
      "phone_e164, stage, expected, lane, draft_property, draft_unit, draft_issue, draft_schedule_raw, active_artifact_key, expires_at_iso, updated_at_iso"
    )
    .eq("phone_e164", key)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

/**
 * @param {object} row
 * @param {string} row.phone_e164
 * @param {string} [row.stage]
 * @param {string} [row.expected]
 * @param {string} [row.lane]
 * @param {string} [row.draft_property]
 * @param {string} [row.draft_unit]
 * @param {string} [row.draft_issue]
 * @param {string} [row.draft_schedule_raw]
 * @param {string} [row.active_artifact_key] — ticket_key uuid while waiting post-create schedule
 * @param {string} [row.expires_at_iso]
 */
async function upsertIntakeSession(row) {
  const sb = getSupabase();
  if (!sb || !row || !row.phone_e164) return { ok: false };

  const now = new Date().toISOString();
  const payload = {
    phone_e164: String(row.phone_e164).trim(),
    stage: String(row.stage != null ? row.stage : ""),
    expected: String(row.expected != null ? row.expected : ""),
    lane: String(row.lane != null ? row.lane : "MAINTENANCE"),
    draft_property: String(row.draft_property != null ? row.draft_property : ""),
    draft_unit: String(row.draft_unit != null ? row.draft_unit : ""),
    draft_issue: String(row.draft_issue != null ? row.draft_issue : ""),
    draft_schedule_raw: String(
      row.draft_schedule_raw != null ? row.draft_schedule_raw : ""
    ),
    active_artifact_key: String(
      row.active_artifact_key != null ? row.active_artifact_key : ""
    ),
    expires_at_iso: String(row.expires_at_iso != null ? row.expires_at_iso : ""),
    updated_at_iso: now,
  };

  const { error } = await sb.from("intake_sessions").upsert(payload, {
    onConflict: "phone_e164",
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Clear maintenance draft after successful finalize (GAS `finalize_session_close` class).
 * @param {string} phoneE164
 */
async function clearIntakeSessionDraft(phoneE164) {
  const sb = getSupabase();
  if (!sb) return { ok: false };
  const key = String(phoneE164 || "").trim();
  if (!key) return { ok: false };

  const { error } = await sb.from("intake_sessions").upsert(
    {
      phone_e164: key,
      stage: "",
      expected: "",
      lane: "MAINTENANCE",
      draft_property: "",
      draft_unit: "",
      draft_issue: "",
      draft_schedule_raw: "",
      active_artifact_key: "",
      expires_at_iso: "",
      updated_at_iso: new Date().toISOString(),
    },
    { onConflict: "phone_e164" }
  );
  if (error) return { ok: false };
  return { ok: true };
}

/**
 * After ticket create — GAS `TICKET_CREATED_ASK_SCHEDULE` / WI wait on SCHEDULE.
 * Keeps draft slots so the next turn can merge schedule only; `active_artifact_key` = ticket_key.
 * @param {string} phoneE164
 * @param {{ ticketKey: string, draft_issue: string, draft_property: string, draft_unit: string }} o
 */
async function setScheduleWaitAfterFinalize(phoneE164, o) {
  return upsertIntakeSession({
    phone_e164: phoneE164,
    stage: "SCHEDULE",
    expected: "SCHEDULE",
    lane: "MAINTENANCE",
    draft_issue: o.draft_issue,
    draft_property: o.draft_property,
    draft_unit: o.draft_unit,
    draft_schedule_raw: "",
    active_artifact_key: o.ticketKey,
    expires_at_iso: "",
  });
}

/**
 * Tenant-facing property picker — real buildings only.
 * `GLOBAL` stays in `properties` for staff assignments + roster; it must not appear here.
 * Policy defaults use `property_policy.property_code = 'GLOBAL'` (separate table), not this list.
 *
 * @returns {Promise<Array<{ code: string, display_name: string, aliases: string[] }>>}
 */
async function listPropertiesForMenu() {
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("properties")
    .select("code, display_name")
    .eq("active", true)
    .neq("code", "GLOBAL")
    .order("code");

  if (error || !data) return [];

  // Optional table (009 migration). If missing, keep behavior with empty aliases.
  let aliasByCode = {};
  try {
    const { data: aliasRows, error: aliasErr } = await sb
      .from("property_aliases")
      .select("property_code, alias")
      .eq("active", true);
    if (!aliasErr && Array.isArray(aliasRows)) {
      for (const row of aliasRows) {
        const code = String(row && row.property_code ? row.property_code : "")
          .trim()
          .toUpperCase();
        const alias = String(row && row.alias ? row.alias : "").trim();
        if (!code || !alias) continue;
        if (!aliasByCode[code]) aliasByCode[code] = [];
        aliasByCode[code].push(alias);
      }
    }
  } catch (_) {}

  return data.map((r) => ({
    code: String(r.code || "").toUpperCase(),
    display_name: String(r.display_name || ""),
    aliases: aliasByCode[String(r.code || "").toUpperCase()] || [],
  }));
}

module.exports = {
  getIntakeSession,
  upsertIntakeSession,
  clearIntakeSessionDraft,
  setScheduleWaitAfterFinalize,
  listPropertiesForMenu,
};
