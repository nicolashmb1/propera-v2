/**
 * Default seed rules for new orgs — staff edit in portal Settings → Rent reminders.
 * Optional override: PROPERA_BALANCE_REMINDER_RULES_JSON (initial seed only; portal is source of truth).
 */

const DEFAULT_RULES = [
  {
    id: "day_5_rent_reminder",
    enabled: true,
    dayOfMonth: 5,
    minBalanceCents: 1,
    commType: "LEASE_ADMIN",
    title: "Rent reminder — day 5",
    messageBody:
      "Reminder: your rent balance is outstanding. Please pay promptly to avoid a late fee. Questions? Reply to this message or contact the office.",
    deliveryMode: "sms_only",
    propertyCodes: [],
  },
  {
    id: "day_15_late_fee_warning",
    enabled: true,
    dayOfMonth: 15,
    minBalanceCents: 1,
    commType: "LEASE_ADMIN",
    title: "Late fee warning — day 15",
    messageBody:
      "Your rent balance is still outstanding. A bank/late fee will be added to your account if payment is not received. Please pay today or contact the office.",
    deliveryMode: "sms_only",
    propertyCodes: [],
  },
  {
    id: "day_30_invoice_notice",
    enabled: true,
    dayOfMonth: 30,
    minBalanceCents: 1,
    commType: "LEASE_ADMIN",
    title: "Balance invoice notice — day 30",
    messageBody:
      "Your account has an outstanding balance. A digital invoice has been issued — please check your tenant portal or contact the office to arrange payment.",
    deliveryMode: "sms_and_portal",
    propertyCodes: [],
  },
];

function parseRulesJson(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.rules) ? parsed.rules : null;
  } catch (_) {
    return null;
  }
}

function normalizeRule(rule, index) {
  if (!rule || typeof rule !== "object") return null;
  const id = String(rule.id || rule.ruleId || `rule_${index + 1}`).trim();
  const dayOfMonth = Math.max(1, Math.min(31, Math.floor(Number(rule.dayOfMonth ?? rule.day_of_month) || 0)));
  if (!id || !dayOfMonth) return null;

  const deliveryModeRaw = String(rule.deliveryMode || rule.delivery_mode || "sms_only").trim().toLowerCase();
  let deliveryMode = "sms_only";
  if (deliveryModeRaw === "sms_and_portal") deliveryMode = "sms_and_portal";
  else if (deliveryModeRaw === "portal_only") deliveryMode = "portal_only";

  const propertyCodes = [];
  const seen = new Set();
  for (const raw of Array.isArray(rule.propertyCodes || rule.property_codes) ? rule.propertyCodes || rule.property_codes : []) {
    const code = String(raw || "").trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    propertyCodes.push(code);
  }

  return {
    id,
    enabled: rule.enabled !== false,
    dayOfMonth,
    minBalanceCents: Math.max(0, Math.floor(Number(rule.minBalanceCents ?? rule.min_balance_cents ?? 1) || 0)),
    commType: String(rule.commType || rule.comm_type || "LEASE_ADMIN").trim().toUpperCase() || "LEASE_ADMIN",
    title: String(rule.title || id).trim() || id,
    messageBody: String(rule.messageBody || rule.message_body || "").trim(),
    deliveryMode,
    propertyCodes,
  };
}

function loadBalanceReminderRules() {
  const fromEnv = parseRulesJson(process.env.PROPERA_BALANCE_REMINDER_RULES_JSON);
  const source = fromEnv && fromEnv.length ? fromEnv : DEFAULT_RULES;
  const rules = [];
  for (let i = 0; i < source.length; i += 1) {
    const normalized = normalizeRule(source[i], i);
    if (normalized && normalized.messageBody) rules.push(normalized);
  }
  return rules;
}

module.exports = {
  DEFAULT_RULES,
  loadBalanceReminderRules,
  normalizeRule,
};
