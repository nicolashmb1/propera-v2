/**
 * Balance-triggered lease reminders — cron worker for Communication Engine.
 *
 * Patch Law: lives in src/communication/ only; uses campaignService + commOutgate.
 * Does NOT write lifecycle/work-item state. Balance is read from tenant_account_snapshots.
 */

const { getSupabase } = require("../db/supabase");
const {
  communicationEngineEnabled,
  communicationOrgId,
  twilioOutboundEnabled,
  properaTimezone,
} = require("../config/env");
const { appendEventLog } = require("../dal/appendEventLog");
const { normalizeUnit_ } = require("../brain/shared/extractUnitGas");
const {
  loadEnabledBalanceReminderRules,
  listOrgsWithBalanceRemindersEnabled,
} = require("../dal/portalBalanceReminders");
const { loadSuppressedTenantIds } = require("../dal/balanceReminderSuppression");
const { createCampaign, prepareCampaign, sendCampaignNow } = require("./campaignService");

const ACCOUNTING_SOURCE = String(process.env.PROPERA_ACCOUNTING_SOURCE || "leasehold").trim() || "leasehold";

function buildUnitKey(propertyCode, unitLabel) {
  const code = String(propertyCode || "").trim().toUpperCase();
  const unit = normalizeUnit_(unitLabel);
  return code && unit ? `${code}::${unit}` : "";
}

function calendarPartsInTz(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const pick = (type) => {
    const part = parts.find((p) => p.type === type);
    return part ? part.value : "";
  };
  let hour = Number(pick("hour"));
  if (hour === 24) hour = 0;
  return {
    year: pick("year"),
    month: pick("month"),
    day: Number(pick("day")),
    hour,
    minute: Number(pick("minute")),
  };
}

/** True when local time is within [target, target + windowMinutes) — matches 15-min cron ticks. */
function isWithinSendWindow(localHour, localMinute, sendHour, sendMinute, windowMinutes = 15) {
  const nowMins = localHour * 60 + localMinute;
  const targetMins = sendHour * 60 + sendMinute;
  const diff = nowMins - targetMins;
  return diff >= 0 && diff < windowMinutes;
}

function periodKeyFromParts(parts) {
  return `${parts.year}-${parts.month}`;
}

async function fetchDelinquentTenantIds(sb, minBalanceCents, propertyCodes, periodKey) {
  let snapQuery = sb
    .from("tenant_account_snapshots")
    .select("unit_catalog_id, property_code, balance_cents")
    .eq("source_system", ACCOUNTING_SOURCE)
    .gte("balance_cents", minBalanceCents);
  if (Array.isArray(propertyCodes) && propertyCodes.length) {
    snapQuery = snapQuery.in(
      "property_code",
      propertyCodes.map((c) => String(c || "").trim().toUpperCase()).filter(Boolean)
    );
  }
  const { data: snapshots, error: snapError } = await snapQuery;
  if (snapError) return { ok: false, error: snapError.message || "snapshot_query_failed", tenantIds: [] };

  const delinquentUnitIds = new Set(
    (snapshots || [])
      .map((row) => String(row.unit_catalog_id || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (!delinquentUnitIds.size) {
    return { ok: true, tenantIds: [], eligibleCount: 0 };
  }

  const { data: unitRows, error: unitError } = await sb
    .from("units")
    .select("id, property_code, unit_label")
    .in("id", Array.from(delinquentUnitIds));
  if (unitError) return { ok: false, error: unitError.message || "units_query_failed", tenantIds: [] };

  const unitById = new Map();
  for (const unit of unitRows || []) {
    unitById.set(String(unit.id || "").trim().toLowerCase(), unit);
  }

  let rosterQuery = sb
    .from("tenant_roster")
    .select("id, property_code, unit_label, phone_e164, active, comm_broadcast_opt_out")
    .eq("active", true);
  if (Array.isArray(propertyCodes) && propertyCodes.length) {
    rosterQuery = rosterQuery.in(
      "property_code",
      propertyCodes.map((c) => String(c || "").trim().toUpperCase()).filter(Boolean)
    );
  }
  const { data: rosterRows, error: rosterError } = await rosterQuery;
  if (rosterError) return { ok: false, error: rosterError.message || "roster_query_failed", tenantIds: [] };

  const tenantIds = [];
  const seen = new Set();
  for (const snap of snapshots || []) {
    const unitId = String(snap.unit_catalog_id || "").trim().toLowerCase();
    const unit = unitById.get(unitId);
    if (!unit) continue;
    const unitKey = buildUnitKey(unit.property_code, unit.unit_label);
    if (!unitKey) continue;

    for (const row of rosterRows || []) {
      const rosterKey = buildUnitKey(row.property_code, row.unit_label);
      if (rosterKey !== unitKey) continue;
      if (row.comm_broadcast_opt_out === true) continue;
      if (!String(row.phone_e164 || "").trim()) continue;
      const tenantId = String(row.id || "").trim().toLowerCase();
      if (!tenantId || seen.has(tenantId)) continue;
      seen.add(tenantId);
      tenantIds.push(tenantId);
    }
  }

  let filteredIds = tenantIds;
  let suppressedCount = 0;
  if (periodKey && tenantIds.length) {
    const suppressed = await loadSuppressedTenantIds(sb, tenantIds, periodKey);
    if (suppressed.size) {
      filteredIds = tenantIds.filter((id) => !suppressed.has(id));
      suppressedCount = tenantIds.length - filteredIds.length;
    }
  }

  return {
    ok: true,
    tenantIds: filteredIds,
    eligibleCount: filteredIds.length,
    suppressedCount,
  };
}

async function ruleAlreadyRan(sb, ruleId, periodKey) {
  const { data, error } = await sb
    .from("balance_reminder_runs")
    .select("id")
    .eq("rule_id", ruleId)
    .eq("period_key", periodKey)
    .maybeSingle();
  if (error) {
    if (/balance_reminder_runs|does not exist/i.test(error.message)) return false;
    throw new Error(error.message || "dedupe_check_failed");
  }
  return Boolean(data && data.id);
}

async function recordRuleRun(sb, row) {
  const { error } = await sb.from("balance_reminder_runs").insert(row);
  if (error) throw new Error(error.message || "balance_reminder_run_insert_failed");
}

async function runBalanceReminderRule(sb, rule, context) {
  const { periodKey, traceId, orgId } = context;
  if (!rule.enabled) {
    return { ok: true, ruleId: rule.id, skipped: "rule_disabled" };
  }

  const already = await ruleAlreadyRan(sb, rule.id, periodKey);
  if (already) {
    return { ok: true, ruleId: rule.id, skipped: "already_ran_this_period" };
  }

  const eligible = await fetchDelinquentTenantIds(sb, rule.minBalanceCents, rule.propertyCodes, periodKey);
  if (!eligible.ok) {
    return { ok: false, ruleId: rule.id, error: eligible.error };
  }
  if (!eligible.tenantIds.length) {
    await recordRuleRun(sb, {
      rule_id: rule.id,
      period_key: periodKey,
      eligible_count: 0,
      sent_count: 0,
      failed_count: 0,
    });
    return { ok: true, ruleId: rule.id, skipped: "no_eligible_tenants", eligibleCount: 0, suppressedCount: eligible.suppressedCount || 0 };
  }

  const audienceKind = rule.propertyCodes.length === 1 ? "PROPERTY" : "PORTFOLIO";
  const audienceFilter = {
    tenant_ids: eligible.tenantIds,
    delivery_mode: rule.deliveryMode,
    include_tenant_portal: rule.deliveryMode !== "sms_only",
  };
  if (rule.propertyCodes.length) {
    audienceFilter.property_codes = rule.propertyCodes;
  }

  const created = await createCampaign(
    {
      title: rule.title,
      commType: rule.commType,
      audienceKind,
      audienceFilter,
      messageBody: rule.messageBody,
      orgId: orgId || communicationOrgId(),
      createdBy: "BALANCE_REMINDER_CRON",
      commTypeKey: `balance_reminder:${rule.id}`,
      agentInitiated: false,
      aiAssisted: false,
    },
    { traceId }
  );
  if (!created.ok || !created.campaign || !created.campaign.id) {
    return { ok: false, ruleId: rule.id, error: created.error || "campaign_create_failed" };
  }

  const campaignId = created.campaign.id;
  const prepared = await prepareCampaign(campaignId, { traceId });
  if (!prepared.ok) {
    return { ok: false, ruleId: rule.id, campaignId, error: prepared.error || "campaign_prepare_failed" };
  }

  const sent = await sendCampaignNow(campaignId, { traceId });
  if (!sent.ok) {
    return { ok: false, ruleId: rule.id, campaignId, error: sent.error || "campaign_send_failed" };
  }

  const sendStats = sent.send || {};
  await recordRuleRun(sb, {
    rule_id: rule.id,
    period_key: periodKey,
    campaign_id: campaignId,
    eligible_count: eligible.eligibleCount,
    sent_count: Number(sendStats.sent || 0),
    failed_count: Number(sendStats.failed || 0),
  });

  await appendEventLog({
    traceId,
    log_kind: "communication",
    event: "BALANCE_REMINDER_RULE_SENT",
    payload: {
      rule_id: rule.id,
      period_key: periodKey,
      campaign_id: campaignId,
      eligible_count: eligible.eligibleCount,
      suppressed_count: eligible.suppressedCount || 0,
      sent: sendStats.sent || 0,
      failed: sendStats.failed || 0,
    },
  });

  return {
    ok: true,
    ruleId: rule.id,
    campaignId,
    eligibleCount: eligible.eligibleCount,
    suppressedCount: eligible.suppressedCount || 0,
    sent: sendStats.sent || 0,
    failed: sendStats.failed || 0,
  };
}

/**
 * Cron entry — evaluates DB-configured rules for today's day-of-month in PROPERA_TZ
 * at the org-configured send time (default 10:00 local).
 * Staff enable/configure rules in portal Settings → Rent reminders.
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ traceId?: string, forceDay?: number, forceSend?: boolean, orgId?: string }} opts
 */
async function processDueBalanceReminders(sb, opts) {
  const traceId = opts && opts.traceId;
  const forceSend = opts && opts.forceSend === true;
  if (!communicationEngineEnabled()) {
    return { ok: false, error: "communication_engine_disabled" };
  }
  if (!twilioOutboundEnabled()) {
    return { ok: false, error: "twilio_outbound_disabled" };
  }
  if (!sb) return { ok: false, error: "no_db" };

  const tz = properaTimezone() || "America/New_York";
  const now = new Date();
  const parts = calendarPartsInTz(now, tz);
  const todayDay =
    opts && Number.isFinite(Number(opts.forceDay))
      ? Math.max(1, Math.min(31, Math.floor(Number(opts.forceDay))))
      : parts.day;
  const periodKey = periodKeyFromParts(parts);

  let orgIds = [];
  if (opts && opts.orgId) {
    orgIds = [String(opts.orgId).trim().toLowerCase()].filter(Boolean);
  } else {
    const orgList = await listOrgsWithBalanceRemindersEnabled(sb);
    if (!orgList.ok) return { ok: false, error: orgList.error };
    orgIds = orgList.orgIds;
    if (!orgIds.length) {
      const fallback = String(communicationOrgId() || "").trim().toLowerCase();
      if (fallback) {
        const loaded = await loadEnabledBalanceReminderRules(sb, fallback);
        if (loaded.ok && loaded.enabled) orgIds = [fallback];
      }
    }
  }

  if (!orgIds.length) {
    return {
      ok: true,
      skipped: "automation_disabled",
      timezone: tz,
      todayDay,
      periodKey,
    };
  }

  const allResults = [];
  for (const orgId of orgIds) {
    const loaded = await loadEnabledBalanceReminderRules(sb, orgId);
    if (!loaded.ok) {
      allResults.push({ ok: false, orgId, error: loaded.error });
      continue;
    }
    if (!loaded.enabled || !loaded.rules.length) {
      allResults.push({ ok: true, orgId, skipped: "automation_disabled_or_no_rules" });
      continue;
    }

    const sendHour = Number.isFinite(Number(loaded.sendHour)) ? Number(loaded.sendHour) : 10;
    const sendMinute = Number.isFinite(Number(loaded.sendMinute)) ? Number(loaded.sendMinute) : 0;
    if (
      !forceSend &&
      !isWithinSendWindow(parts.hour, parts.minute, sendHour, sendMinute)
    ) {
      allResults.push({
        ok: true,
        orgId,
        skipped: "outside_send_window",
        sendHour,
        sendMinute,
        localHour: parts.hour,
        localMinute: parts.minute,
      });
      continue;
    }

    const dueRules = loaded.rules.filter((rule) => rule.enabled && rule.dayOfMonth === todayDay);
    if (!dueRules.length) {
      allResults.push({
        ok: true,
        orgId,
        skipped: "no_rules_due_today",
        rulesConfigured: loaded.rules.length,
      });
      continue;
    }

    for (const rule of dueRules) {
      try {
        const out = await runBalanceReminderRule(sb, rule, { periodKey, traceId, orgId });
        allResults.push({ ...out, orgId });
      } catch (err) {
        allResults.push({
          ok: false,
          orgId,
          ruleId: rule.id,
          error: String(err && err.message ? err.message : err),
        });
      }
    }
  }

  const failed = allResults.filter((r) => r.ok === false);
  return {
    ok: failed.length === 0,
    timezone: tz,
    todayDay,
    localHour: parts.hour,
    localMinute: parts.minute,
    periodKey,
    orgCount: orgIds.length,
    results: allResults,
  };
}

module.exports = {
  processDueBalanceReminders,
  fetchDelinquentTenantIds,
  calendarPartsInTz,
  isWithinSendWindow,
};
