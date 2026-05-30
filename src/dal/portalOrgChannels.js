/**
 * MO-3 org channel metadata — Settings catalog only (not inbound routing yet).
 * Twilio account credentials stay in platform env; this table stores numbers + setup state.
 * @see docs/MULTI_ORG_ARCHITECTURE.md
 */
const {
  twilioAccountSid,
  twilioAuthToken,
  twilioSmsFrom,
  twilioWhatsappFrom,
  twilioBroadcastFrom,
  telegramBotToken,
  telegramWebhookSecret,
  twilioOutboundEnabled,
  telegramOutboundEnabled,
  commMainNumberDisplay,
  properaPublicBaseUrl,
} = require("../config/env");
const { normalizePhoneE164 } = require("../utils/phone");

const CHANNEL_CATALOG = [
  {
    channelKey: "maintenance_sms",
    label: "Maintenance SMS",
    description: "Main tenant and staff maintenance line (main brain inbound).",
    inboundWebhookPath: "/webhooks/sms",
    altInboundWebhookPath: "/webhooks/twilio",
    platformEnvVar: "TWILIO_SMS_FROM",
    displayEnvVar: "COMM_MAIN_NUMBER_DISPLAY",
    kind: "phone",
  },
  {
    channelKey: "broadcast_sms",
    label: "Broadcast SMS",
    description: "Building announcements via Communication Engine (separate number).",
    inboundWebhookPath: "/webhooks/communications/sms",
    statusWebhookPath: "/webhooks/communications/status",
    platformEnvVar: "TWILIO_BROADCAST_FROM",
    kind: "phone",
  },
  {
    channelKey: "tenant_otp",
    label: "Tenant portal OTP",
    description: "SMS login codes for the resident portal (often same number as maintenance).",
    platformEnvVar: "TWILIO_SMS_FROM",
    kind: "phone",
    sharesPlatformEnvWith: "maintenance_sms",
  },
  {
    channelKey: "whatsapp_maintenance",
    label: "WhatsApp (maintenance)",
    description: "WhatsApp inbound on the main brain webhook.",
    inboundWebhookPath: "/webhooks/sms",
    platformEnvVar: "TWILIO_WHATSAPP_FROM",
    kind: "phone",
  },
  {
    channelKey: "telegram",
    label: "Telegram bot",
    description: "Staff and tenant Telegram intake (bot token stays in platform env).",
    inboundWebhookPath: "/webhooks/telegram",
    platformEnvVar: "TELEGRAM_BOT_TOKEN",
    platformSecretEnvVar: "TELEGRAM_WEBHOOK_SECRET",
    kind: "telegram",
  },
];

const SETUP_STATUSES = [
  "not_started",
  "number_saved",
  "webhook_pending",
  "active",
  "disabled",
];

function normOrg(orgId) {
  return String(orgId || "").trim().toLowerCase();
}

function maskPhoneE164(phone) {
  const p = String(phone || "").trim();
  if (!p) return "";
  if (p.length <= 4) return p;
  const tail = p.slice(-4);
  const prefix = p.startsWith("+") ? p.slice(0, 2) : "";
  return `${prefix} ••• ••• ${tail}`;
}

function platformPhoneForChannel(channelKey) {
  switch (String(channelKey || "").trim()) {
    case "maintenance_sms":
    case "tenant_otp":
      return normalizePhoneE164(twilioSmsFrom());
    case "broadcast_sms":
      return normalizePhoneE164(twilioBroadcastFrom());
    case "whatsapp_maintenance":
      return normalizePhoneE164(
        String(twilioWhatsappFrom() || "")
          .replace(/^whatsapp:/i, "")
          .trim()
      );
    default:
      return "";
  }
}

function platformDisplayForChannel(channelKey) {
  if (channelKey === "maintenance_sms") {
    const d = String(commMainNumberDisplay() || "").trim();
    return d || twilioSmsFrom();
  }
  if (channelKey === "broadcast_sms") return twilioBroadcastFrom();
  if (channelKey === "tenant_otp") return twilioSmsFrom();
  if (channelKey === "whatsapp_maintenance") return twilioWhatsappFrom();
  return "";
}

function platformSecretsPresent(channelKey) {
  const key = String(channelKey || "").trim();
  if (key === "telegram") {
    return {
      platformConfigured: !!telegramBotToken(),
      outboundEnabled: telegramOutboundEnabled(),
      accountPresent: !!telegramBotToken(),
      webhookSecretPresent: !!telegramWebhookSecret(),
    };
  }
  return {
    platformConfigured: !!twilioAccountSid() && !!twilioAuthToken(),
    outboundEnabled: twilioOutboundEnabled(),
    accountPresent: !!twilioAccountSid() && !!twilioAuthToken(),
    fromPresent: !!platformPhoneForChannel(key),
  };
}

function webhookUrl(path) {
  const base = String(properaPublicBaseUrl() || "").trim().replace(/\/+$/, "");
  const p = String(path || "").trim();
  if (!base || !p) return "";
  return `${base}${p.startsWith("/") ? p : `/${p}`}`;
}

function setupStepsForChannel(catalog, row, platform) {
  const steps = [];
  if (catalog.kind === "phone") {
    steps.push({
      id: "provision",
      label: "Provision a Twilio phone number",
      detail: "In Twilio Console, buy or assign a number for this lane.",
      done: !!String(row.phoneE164 || "").trim() || platform.fromPresent,
    });
    steps.push({
      id: "save_number",
      label: "Save the E.164 number here",
      detail: "Record which number belongs to this organization (metadata only).",
      done: !!String(row.phoneE164 || "").trim(),
    });
    steps.push({
      id: "platform_env",
      label: "Platform operator sets env var",
      detail: `Ask your Propera operator to set ${catalog.platformEnvVar} on the V2 server.`,
      done: platform.fromPresent,
    });
    if (catalog.inboundWebhookPath) {
      const url = webhookUrl(catalog.inboundWebhookPath);
      steps.push({
        id: "webhook",
        label: "Point Twilio webhook at V2",
        detail: url
          ? `POST ${url}${catalog.altInboundWebhookPath ? ` (or ${webhookUrl(catalog.altInboundWebhookPath)})` : ""}`
          : "Set PROPERA_PUBLIC_BASE_URL on V2 to show the full webhook URL.",
        done: row.setupStatus === "active" || row.setupStatus === "webhook_pending",
      });
    }
    if (catalog.statusWebhookPath) {
      steps.push({
        id: "status_webhook",
        label: "Configure delivery status callback",
        detail: webhookUrl(catalog.statusWebhookPath)
          ? `POST ${webhookUrl(catalog.statusWebhookPath)}`
          : "Set PROPERA_PUBLIC_BASE_URL on V2 to show the status URL.",
        done: row.setupStatus === "active",
      });
    }
  } else if (catalog.kind === "telegram") {
    steps.push({
      id: "bot",
      label: "Create Telegram bot via BotFather",
      detail: "Obtain bot token; platform operator sets TELEGRAM_BOT_TOKEN.",
      done: platform.accountPresent,
    });
    steps.push({
      id: "username",
      label: "Save bot @username",
      detail: "Helps staff recognize the correct bot in Telegram.",
      done: !!String(row.telegramBotUsername || "").trim(),
    });
    steps.push({
      id: "webhook",
      label: "Register Telegram webhook",
      detail: webhookUrl(catalog.inboundWebhookPath)
        ? `POST ${webhookUrl(catalog.inboundWebhookPath)}`
        : "Set PROPERA_PUBLIC_BASE_URL on V2 to show the webhook URL.",
      done: row.setupStatus === "active" || row.setupStatus === "webhook_pending",
    });
  }
  steps.push({
    id: "mark_active",
    label: "Mark channel active when verified",
    detail: "Send a test message and confirm intake before marking active.",
    done: row.setupStatus === "active",
  });
  return steps;
}

function mapChannelRow(row) {
  return {
    id: String(row.id || ""),
    channelKey: String(row.channel_key || "").trim(),
    phoneE164: String(row.phone_e164 || "").trim(),
    displayNumber: String(row.display_number || "").trim(),
    telegramBotUsername: String(row.telegram_bot_username || "").trim(),
    setupStatus: String(row.setup_status || "not_started").trim(),
    operatorNotes: String(row.operator_notes || "").trim(),
    active: row.active !== false,
    updatedAt: String(row.updated_at || ""),
  };
}

function mergeChannelView(catalog, dbRow) {
  const row = dbRow
    ? mapChannelRow(dbRow)
    : {
        id: "",
        channelKey: catalog.channelKey,
        phoneE164: "",
        displayNumber: "",
        telegramBotUsername: "",
        setupStatus: "not_started",
        operatorNotes: "",
        active: true,
        updatedAt: "",
      };

  const platformPhone = platformPhoneForChannel(catalog.channelKey);
  const savedPhone = normalizePhoneE164(row.phoneE164);
  const platform = platformSecretsPresent(catalog.channelKey);
  const phoneMatchesPlatform =
    !!savedPhone && !!platformPhone && savedPhone === platformPhone;

  return {
    ...row,
    label: catalog.label,
    description: catalog.description,
    kind: catalog.kind,
    platformEnvVar: catalog.platformEnvVar || "",
    displayEnvVar: catalog.displayEnvVar || "",
    sharesPlatformEnvWith: catalog.sharesPlatformEnvWith || "",
    inboundWebhookPath: catalog.inboundWebhookPath || "",
    altInboundWebhookPath: catalog.altInboundWebhookPath || "",
    statusWebhookPath: catalog.statusWebhookPath || "",
    inboundWebhookUrl: webhookUrl(catalog.inboundWebhookPath),
    altInboundWebhookUrl: webhookUrl(catalog.altInboundWebhookPath),
    statusWebhookUrl: webhookUrl(catalog.statusWebhookPath),
    platform: {
      ...platform,
      fromMasked: maskPhoneE164(platformPhone),
      displayHint: platformDisplayForChannel(catalog.channelKey),
      phoneMatchesSaved: phoneMatchesPlatform,
    },
    setupSteps: setupStepsForChannel(catalog, row, platform),
  };
}

async function ensureDefaultChannelRows(sb, orgId) {
  const oid = normOrg(orgId);
  if (!oid) return { ok: false, error: "missing_org_id" };

  const rows = CHANNEL_CATALOG.map((c) => ({
    org_id: oid,
    channel_key: c.channelKey,
  }));

  const { error } = await sb
    .from("org_channel_configs")
    .upsert(rows, { onConflict: "org_id,channel_key", ignoreDuplicates: true });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

async function listOrgChannelsForPortal(sb, orgId) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  if (!oid) return { ok: false, error: "missing_org_id" };

  const ensure = await ensureDefaultChannelRows(sb, oid);
  if (!ensure.ok) return ensure;

  const { data, error } = await sb
    .from("org_channel_configs")
    .select(
      "id, org_id, channel_key, phone_e164, display_number, telegram_bot_username, setup_status, operator_notes, active, updated_at"
    )
    .eq("org_id", oid)
    .order("channel_key", { ascending: true });

  if (error) return { ok: false, error: error.message };

  const byKey = new Map(
    (Array.isArray(data) ? data : []).map((row) => [String(row.channel_key || "").trim(), row])
  );

  const channels = CHANNEL_CATALOG.map((catalog) =>
    mergeChannelView(catalog, byKey.get(catalog.channelKey))
  );

  return {
    ok: true,
    orgId: oid,
    publicBaseUrl: String(properaPublicBaseUrl() || "").trim(),
    channels,
  };
}

async function patchOrgChannelForPortal(sb, orgId, channelKey, patch) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  const key = String(channelKey || "").trim();
  const catalog = CHANNEL_CATALOG.find((c) => c.channelKey === key);
  if (!oid) return { ok: false, error: "missing_org_id", status: 400 };
  if (!catalog) return { ok: false, error: "unknown_channel", status: 400 };

  const ensure = await ensureDefaultChannelRows(sb, oid);
  if (!ensure.ok) return ensure;

  const updates = { updated_at: new Date().toISOString() };

  if (patch.phoneE164 != null || patch.phone_e164 != null) {
    const raw = String(patch.phoneE164 ?? patch.phone_e164 ?? "").trim();
    if (raw && catalog.kind === "phone") {
      const normalized = normalizePhoneE164(raw);
      if (!normalized || !/^\+[1-9]\d{6,14}$/.test(normalized)) {
        return { ok: false, error: "invalid_phone", status: 400 };
      }
      updates.phone_e164 = normalized;
    } else if (!raw) {
      updates.phone_e164 = "";
    }
  }

  if (patch.displayNumber != null || patch.display_number != null) {
    updates.display_number = String(patch.displayNumber ?? patch.display_number ?? "")
      .trim()
      .slice(0, 40);
  }

  if (patch.telegramBotUsername != null || patch.telegram_bot_username != null) {
    const u = String(patch.telegramBotUsername ?? patch.telegram_bot_username ?? "")
      .trim()
      .replace(/^@/, "")
      .slice(0, 64);
    updates.telegram_bot_username = u;
  }

  if (patch.setupStatus != null || patch.setup_status != null) {
    const st = String(patch.setupStatus ?? patch.setup_status ?? "")
      .trim()
      .toLowerCase();
    if (!SETUP_STATUSES.includes(st)) {
      return { ok: false, error: "invalid_setup_status", status: 400 };
    }
    updates.setup_status = st;
  }

  if (patch.operatorNotes != null || patch.operator_notes != null) {
    updates.operator_notes = String(patch.operatorNotes ?? patch.operator_notes ?? "")
      .trim()
      .slice(0, 2000);
  }

  if (patch.active != null) {
    updates.active = patch.active === true || patch.active === "1" || patch.active === 1;
  }

  if (Object.keys(updates).length <= 1) {
    return { ok: false, error: "no_changes", status: 400 };
  }

  const { data, error } = await sb
    .from("org_channel_configs")
    .update(updates)
    .eq("org_id", oid)
    .eq("channel_key", key)
    .select(
      "id, org_id, channel_key, phone_e164, display_number, telegram_bot_username, setup_status, operator_notes, active, updated_at"
    )
    .maybeSingle();

  if (error) return { ok: false, error: error.message, status: 500 };
  if (!data) return { ok: false, error: "channel_not_found", status: 404 };

  return {
    ok: true,
    channel: mergeChannelView(catalog, data),
  };
}

module.exports = {
  CHANNEL_CATALOG,
  ensureDefaultChannelRows,
  listOrgChannelsForPortal,
  patchOrgChannelForPortal,
};
