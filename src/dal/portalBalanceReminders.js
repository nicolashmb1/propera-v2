/**
 * Balance-triggered rent reminders — portal Settings CRUD.
 * Cron reads these rows; staff edit via propera-app Settings → Rent reminders.
 */

const { DEFAULT_RULES } = require("../communication/balanceReminderRules.config");
const { properaTimezone } = require("../config/env");

const DELIVERY_MODES = new Set(["sms_only", "sms_and_portal", "portal_only"]);
const DEFAULT_SEND_HOUR = 10;
const DEFAULT_SEND_MINUTE = 0;

function clampSendHour(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(23, n));
}

function clampSendMinute(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(59, n));
}

function mapSettingsRow(row) {
  const sendHour = clampSendHour(row?.send_hour);
  const sendMinute = clampSendMinute(row?.send_minute);
  return {
    enabled: row?.enabled === true,
    sendHour: sendHour == null ? DEFAULT_SEND_HOUR : sendHour,
    sendMinute: sendMinute == null ? DEFAULT_SEND_MINUTE : sendMinute,
    updatedAt: row?.updated_at || null,
  };
}

function normOrg(orgId) {
  return String(orgId || "").trim().toLowerCase();
}

function mapRuleRow(row) {
  if (!row) return null;
  const propertyCodes = Array.isArray(row.property_codes)
    ? row.property_codes.map((c) => String(c || "").trim().toUpperCase()).filter(Boolean)
    : [];
  return {
    id: row.id,
    ruleKey: row.rule_key,
    enabled: row.enabled === true,
    dayOfMonth: Number(row.day_of_month),
    minBalanceCents: Number(row.min_balance_cents),
    title: row.title,
    messageBody: row.message_body,
    deliveryMode: row.delivery_mode || "sms_only",
    propertyCodes,
    sortOrder: Number(row.sort_order) || 0,
    updatedAt: row.updated_at,
  };
}

async function seedDefaultRules(sb, orgId) {
  const org = normOrg(orgId);
  if (!org) return { ok: false, error: "missing_org_id" };

  const { count, error: countError } = await sb
    .from("balance_reminder_rules")
    .select("id", { count: "exact", head: true })
    .eq("org_id", org);
  if (countError) {
    if (/balance_reminder_rules|does not exist/i.test(countError.message)) {
      return { ok: false, error: "schema_missing" };
    }
    return { ok: false, error: countError.message };
  }
  if (count && count > 0) return { ok: true, seeded: false };

  const rows = DEFAULT_RULES.map((rule, index) => ({
    org_id: org,
    rule_key: rule.id,
    enabled: rule.enabled !== false,
    day_of_month: rule.dayOfMonth,
    min_balance_cents: rule.minBalanceCents,
    title: rule.title,
    message_body: rule.messageBody,
    delivery_mode: rule.deliveryMode || "sms_only",
    property_codes: rule.propertyCodes || [],
    sort_order: index,
  }));

  const { error: insertError } = await sb.from("balance_reminder_rules").insert(rows);
  if (insertError) return { ok: false, error: insertError.message };

  const { error: settingsError } = await sb.from("balance_reminder_settings").upsert(
    {
      org_id: org,
      enabled: false,
      send_hour: DEFAULT_SEND_HOUR,
      send_minute: DEFAULT_SEND_MINUTE,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id" }
  );
  if (settingsError && !/balance_reminder_settings|does not exist/i.test(settingsError.message)) {
    return { ok: false, error: settingsError.message };
  }

  return { ok: true, seeded: true };
}

async function getBalanceReminderSettingsRow(sb, orgId) {
  const org = normOrg(orgId);
  const { data, error } = await sb
    .from("balance_reminder_settings")
    .select("org_id, enabled, send_hour, send_minute, updated_at")
    .eq("org_id", org)
    .maybeSingle();
  if (error) {
    if (/balance_reminder_settings|does not exist/i.test(error.message)) {
      return {
        ok: true,
        settings: {
          enabled: false,
          sendHour: DEFAULT_SEND_HOUR,
          sendMinute: DEFAULT_SEND_MINUTE,
          updatedAt: null,
        },
      };
    }
    return { ok: false, error: error.message };
  }
  return {
    ok: true,
    settings: mapSettingsRow(data),
  };
}

async function listBalanceRemindersForPortal(sb, orgId) {
  const org = normOrg(orgId);
  if (!org) return { ok: false, error: "missing_org_id" };

  const seeded = await seedDefaultRules(sb, org);
  if (!seeded.ok) return seeded;

  const settingsOut = await getBalanceReminderSettingsRow(sb, org);
  if (!settingsOut.ok) return settingsOut;

  const { data, error } = await sb
    .from("balance_reminder_rules")
    .select(
      "id, org_id, rule_key, enabled, day_of_month, min_balance_cents, title, message_body, delivery_mode, property_codes, sort_order, updated_at"
    )
    .eq("org_id", org)
    .order("sort_order", { ascending: true })
    .order("day_of_month", { ascending: true });
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    orgId: org,
    enabled: settingsOut.settings.enabled,
    sendHour: settingsOut.settings.sendHour,
    sendMinute: settingsOut.settings.sendMinute,
    timezone: properaTimezone() || "America/New_York",
    settingsUpdatedAt: settingsOut.settings.updatedAt,
    rules: (data || []).map(mapRuleRow),
  };
}

async function patchBalanceReminderSettingsForPortal(sb, orgId, body) {
  const org = normOrg(orgId);
  if (!org) return { ok: false, error: "missing_org_id" };
  const patch = body && typeof body === "object" ? body : {};

  const update = { updated_at: new Date().toISOString() };
  if (typeof patch.enabled === "boolean") update.enabled = patch.enabled;
  if (patch.sendHour != null || patch.send_hour != null) {
    const hour = clampSendHour(patch.sendHour ?? patch.send_hour);
    if (hour == null) return { ok: false, status: 400, error: "invalid_send_hour" };
    update.send_hour = hour;
  }
  if (patch.sendMinute != null || patch.send_minute != null) {
    const minute = clampSendMinute(patch.sendMinute ?? patch.send_minute);
    if (minute == null) return { ok: false, status: 400, error: "invalid_send_minute" };
    update.send_minute = minute;
  }
  if (Object.keys(update).length <= 1) {
    return { ok: false, status: 400, error: "no_settings_fields" };
  }

  const existing = await getBalanceReminderSettingsRow(sb, org);
  if (!existing.ok) return existing;

  const row = {
    org_id: org,
    enabled: typeof update.enabled === "boolean" ? update.enabled : existing.settings.enabled,
    send_hour: update.send_hour != null ? update.send_hour : existing.settings.sendHour,
    send_minute: update.send_minute != null ? update.send_minute : existing.settings.sendMinute,
    updated_at: update.updated_at,
  };

  const { data, error } = await sb
    .from("balance_reminder_settings")
    .upsert(row, { onConflict: "org_id" })
    .select("org_id, enabled, send_hour, send_minute, updated_at")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };

  const settings = mapSettingsRow(data);
  return {
    ok: true,
    enabled: settings.enabled,
    sendHour: settings.sendHour,
    sendMinute: settings.sendMinute,
    timezone: properaTimezone() || "America/New_York",
    settingsUpdatedAt: settings.updatedAt || update.updated_at,
  };
}

async function patchBalanceReminderRuleForPortal(sb, orgId, ruleKey, body) {
  const org = normOrg(orgId);
  const key = String(ruleKey || "").trim();
  if (!org || !key) return { ok: false, status: 400, error: "missing_rule_key" };

  const patch = body && typeof body === "object" ? body : {};
  const update = { updated_at: new Date().toISOString() };

  if (typeof patch.enabled === "boolean") update.enabled = patch.enabled;
  if (patch.dayOfMonth != null || patch.day_of_month != null) {
    const day = Math.max(1, Math.min(31, Math.floor(Number(patch.dayOfMonth ?? patch.day_of_month))));
    if (!Number.isFinite(day)) return { ok: false, status: 400, error: "invalid_day_of_month" };
    update.day_of_month = day;
  }
  if (patch.minBalanceCents != null || patch.min_balance_cents != null) {
    const cents = Math.max(0, Math.floor(Number(patch.minBalanceCents ?? patch.min_balance_cents)));
    if (!Number.isFinite(cents)) return { ok: false, status: 400, error: "invalid_min_balance" };
    update.min_balance_cents = cents;
  }
  if (patch.title != null) {
    const title = String(patch.title).trim();
    if (!title) return { ok: false, status: 400, error: "invalid_title" };
    update.title = title;
  }
  if (patch.messageBody != null || patch.message_body != null) {
    const msg = String(patch.messageBody ?? patch.message_body).trim();
    if (!msg) return { ok: false, status: 400, error: "invalid_message_body" };
    update.message_body = msg;
  }
  if (patch.deliveryMode != null || patch.delivery_mode != null) {
    const mode = String(patch.deliveryMode ?? patch.delivery_mode).trim().toLowerCase();
    if (!DELIVERY_MODES.has(mode)) return { ok: false, status: 400, error: "invalid_delivery_mode" };
    update.delivery_mode = mode;
  }
  if (patch.propertyCodes != null || patch.property_codes != null) {
    const raw = patch.propertyCodes ?? patch.property_codes;
    const codes = [];
    const seen = new Set();
    for (const item of Array.isArray(raw) ? raw : []) {
      const code = String(item || "").trim().toUpperCase();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
    }
    update.property_codes = codes;
  }

  if (Object.keys(update).length <= 1) {
    return { ok: false, status: 400, error: "empty_patch" };
  }

  const { data, error } = await sb
    .from("balance_reminder_rules")
    .update(update)
    .eq("org_id", org)
    .eq("rule_key", key)
    .select(
      "id, org_id, rule_key, enabled, day_of_month, min_balance_cents, title, message_body, delivery_mode, property_codes, sort_order, updated_at"
    )
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, status: 404, error: "rule_not_found" };

  return { ok: true, rule: mapRuleRow(data) };
}

async function deleteBalanceReminderRuleForPortal(sb, orgId, ruleKey) {
  const org = normOrg(orgId);
  const key = String(ruleKey || "").trim();
  if (!org || !key) return { ok: false, status: 400, error: "missing_rule_key" };

  const { data, error } = await sb
    .from("balance_reminder_rules")
    .delete()
    .eq("org_id", org)
    .eq("rule_key", key)
    .select("rule_key")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, status: 404, error: "rule_not_found" };

  return { ok: true, ruleKey: key };
}

function slugRuleKey(title, dayOfMonth) {
  const base = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  const day = Math.max(1, Math.min(31, Math.floor(Number(dayOfMonth) || 1)));
  return base ? `${base}_day_${day}` : `step_day_${day}`;
}

async function resolveUniqueRuleKey(sb, org, baseKey) {
  const root = String(baseKey || "step").trim() || "step";
  let candidate = root;
  for (let n = 0; n < 50; n += 1) {
    const { data, error } = await sb
      .from("balance_reminder_rules")
      .select("id")
      .eq("org_id", org)
      .eq("rule_key", candidate)
      .maybeSingle();
    if (error) return root;
    if (!data) return candidate;
    candidate = `${root}_${n + 2}`;
  }
  return `${root}_${Date.now()}`;
}

async function createBalanceReminderRuleForPortal(sb, orgId, body) {
  const org = normOrg(orgId);
  if (!org) return { ok: false, status: 400, error: "missing_org_id" };

  const seeded = await seedDefaultRules(sb, org);
  if (!seeded.ok) return seeded;

  const input = body && typeof body === "object" ? body : {};
  const day = Math.max(1, Math.min(31, Math.floor(Number(input.dayOfMonth ?? input.day_of_month ?? 0))));
  if (!Number.isFinite(day) || day < 1) {
    return { ok: false, status: 400, error: "invalid_day_of_month" };
  }

  const title = String(input.title || `Reminder — day ${day}`).trim();
  if (!title) return { ok: false, status: 400, error: "invalid_title" };

  const msg = String(input.messageBody ?? input.message_body ?? "").trim();
  if (!msg) return { ok: false, status: 400, error: "invalid_message_body" };

  const cents = Math.max(0, Math.floor(Number(input.minBalanceCents ?? input.min_balance_cents ?? 1)));
  if (!Number.isFinite(cents)) return { ok: false, status: 400, error: "invalid_min_balance" };

  const mode = String(input.deliveryMode ?? input.delivery_mode ?? "sms_only").trim().toLowerCase();
  if (!DELIVERY_MODES.has(mode)) return { ok: false, status: 400, error: "invalid_delivery_mode" };

  const propertyCodes = [];
  const seen = new Set();
  for (const item of Array.isArray(input.propertyCodes ?? input.property_codes)
    ? input.propertyCodes ?? input.property_codes
    : []) {
    const code = String(item || "").trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    propertyCodes.push(code);
  }

  const { data: maxRow, error: maxError } = await sb
    .from("balance_reminder_rules")
    .select("sort_order")
    .eq("org_id", org)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxError) return { ok: false, error: maxError.message };

  const sortOrder = Number(maxRow?.sort_order ?? -1) + 1;
  const ruleKey = await resolveUniqueRuleKey(sb, org, slugRuleKey(title, day));
  const now = new Date().toISOString();

  const { data, error } = await sb
    .from("balance_reminder_rules")
    .insert({
      org_id: org,
      rule_key: ruleKey,
      enabled: input.enabled === true,
      day_of_month: day,
      min_balance_cents: cents,
      title,
      message_body: msg,
      delivery_mode: mode,
      property_codes: propertyCodes,
      sort_order: sortOrder,
      updated_at: now,
    })
    .select(
      "id, org_id, rule_key, enabled, day_of_month, min_balance_cents, title, message_body, delivery_mode, property_codes, sort_order, updated_at"
    )
    .maybeSingle();
  if (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      return { ok: false, status: 409, error: "rule_key_taken" };
    }
    return { ok: false, error: error.message };
  }
  if (!data) return { ok: false, error: "insert_failed" };

  return { ok: true, rule: mapRuleRow(data) };
}

/** Cron: load enabled rules for an org (after master switch check). */
async function loadEnabledBalanceReminderRules(sb, orgId) {
  const org = normOrg(orgId);
  if (!org) return { ok: false, error: "missing_org_id", rules: [] };

  const settingsOut = await getBalanceReminderSettingsRow(sb, org);
  if (!settingsOut.ok) return { ...settingsOut, rules: [] };
  if (!settingsOut.settings.enabled) {
    return { ok: true, enabled: false, rules: [] };
  }

  await seedDefaultRules(sb, org);

  const { data, error } = await sb
    .from("balance_reminder_rules")
    .select(
      "id, rule_key, enabled, day_of_month, min_balance_cents, title, message_body, delivery_mode, property_codes, sort_order"
    )
    .eq("org_id", org)
    .eq("enabled", true)
    .order("sort_order", { ascending: true });
  if (error) return { ok: false, error: error.message, rules: [] };

  const rules = (data || []).map((row) => ({
    id: row.rule_key,
    enabled: true,
    dayOfMonth: Number(row.day_of_month),
    minBalanceCents: Number(row.min_balance_cents),
    commType: "LEASE_ADMIN",
    title: row.title,
    messageBody: row.message_body,
    deliveryMode: row.delivery_mode || "sms_only",
    propertyCodes: Array.isArray(row.property_codes)
      ? row.property_codes.map((c) => String(c || "").trim().toUpperCase()).filter(Boolean)
      : [],
  }));

  return {
    ok: true,
    enabled: true,
    sendHour: settingsOut.settings.sendHour,
    sendMinute: settingsOut.settings.sendMinute,
    rules,
  };
}

/** Cron: all orgs with automation enabled. */
async function listOrgsWithBalanceRemindersEnabled(sb) {
  const { data, error } = await sb
    .from("balance_reminder_settings")
    .select("org_id")
    .eq("enabled", true);
  if (error) {
    if (/balance_reminder_settings|does not exist/i.test(error.message)) {
      return { ok: true, orgIds: [] };
    }
    return { ok: false, error: error.message, orgIds: [] };
  }
  return {
    ok: true,
    orgIds: (data || []).map((row) => normOrg(row.org_id)).filter(Boolean),
  };
}

module.exports = {
  listBalanceRemindersForPortal,
  patchBalanceReminderSettingsForPortal,
  patchBalanceReminderRuleForPortal,
  createBalanceReminderRuleForPortal,
  deleteBalanceReminderRuleForPortal,
  loadEnabledBalanceReminderRules,
  listOrgsWithBalanceRemindersEnabled,
  seedDefaultRules,
};
