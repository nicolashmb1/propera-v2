/**
 * Propera V2 — minimal HTTP shell (Phase 0).
 * GAS + Sheets remain production until explicit cutover.
 */
const express = require("express");
const {
  port,
  nodeEnv,
  identityApiEnabled,
  telegramOutboundEnabled,
  coreEnabled,
} = require("./config/env");
const { createTrace } = require("./trace/createTrace");
const { isDbConfigured, pingDb } = require("./db/supabase");
const { requestContext } = require("./middleware/requestContext");
const { boot, emit } = require("./logging/structuredLog");
const { resolveActor } = require("./identity/resolveActor");
const { resolveStaffContextFromRouterParameter } = require("./identity/resolveStaffContext");
const { verifyTelegramWebhookSecret } = require("./adapters/telegram/verifyWebhookSecret");
const { normalizeTelegramUpdate } = require("./adapters/telegram/normalizeTelegramUpdate");
const { tryConsumeUpdateId } = require("./adapters/telegram/dedupeUpdateId");
const { upsertTelegramChatLink } = require("./identity/upsertTelegramChatLink");
const { sendTelegramMessage } = require("./outbound/telegramSendMessage");
const { CHANNEL_TELEGRAM } = require("./signal/inboundSignal");
const { buildRouterParameterFromTelegram } = require("./contracts/buildRouterParameterFromTelegram");
const { evaluateRouterPrecursor } = require("./brain/router/evaluateRouterPrecursor");
const { normalizeInboundEventFromRouterParameter } = require("./brain/router/normalizeInboundEvent");
const { decideLane } = require("./brain/router/decideLane");
const { appendEventLog } = require("./dal/appendEventLog");
const { handleStaffLifecycleCommand } = require("./brain/staff/handleStaffLifecycleCommand");
const { handleInboundCore } = require("./brain/core/handleInboundCore");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(requestContext);

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    "Propera V2 — GET /health | POST /webhooks/telegram | dev: GET /api/dev/resolve-actor?phone=+1..."
  );
});

/**
 * Telegram adapter — RouterParameter → precursors → lane (GAS) → staff lifecycle (DB) or tenant path.
 * Core maintenance finalize (tickets/work_items) when CORE_ENABLED + DB; see docs/BRAIN_PORT_MAP.md.
 */
app.post("/webhooks/telegram", async (req, res) => {
  const traceId = req.traceId;

  if (!verifyTelegramWebhookSecret(req)) {
    emit({
      level: "warn",
      trace_id: traceId,
      log_kind: "telegram_webhook",
      event: "secret_mismatch",
      data: {},
    });
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(200).json({ ok: true });
  }

  const msg = payload.message || payload.edited_message;
  if (!msg || !msg.from) {
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "telegram_webhook",
      event: "skipped_no_user_message",
      data: { update_id: payload.update_id ?? null },
    });
    return res.status(200).json({ ok: true, ignored: true });
  }

  if (payload.update_id != null && !tryConsumeUpdateId(payload.update_id)) {
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "telegram_webhook",
      event: "deduped",
      data: { update_id: payload.update_id },
    });
    return res.status(200).json({ ok: true, deduped: true });
  }

  const signal = normalizeTelegramUpdate(payload);
  if (!signal) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  emit({
    level: "info",
    trace_id: traceId,
    log_kind: "telegram_adapter",
    event: "normalized",
    data: {
      channel: signal.channel,
      update_id: signal.transport && signal.transport.update_id,
      chat_id: signal.transport && signal.transport.chat_id,
      text_len: signal.body && signal.body.text ? String(signal.body.text).length : 0,
    },
  });

  if (signal.channel === CHANNEL_TELEGRAM) {
    await upsertTelegramChatLink(signal, traceId);
  }

  let routerParameter;
  try {
    routerParameter = buildRouterParameterFromTelegram(signal, payload);
  } catch (err) {
    emit({
      level: "error",
      trace_id: traceId,
      log_kind: "router_contract",
      event: "build_parameter_failed",
      data: { error: String(err && err.message ? err.message : err) },
    });
    return res.status(200).json({ ok: true, error: "router_parameter_build_failed" });
  }

  const staffContext = await resolveStaffContextFromRouterParameter(routerParameter);
  const precursor = evaluateRouterPrecursor({
    parameter: routerParameter,
    staffContext: {
      isStaff: staffContext.isStaff,
      staffActorKey: staffContext.staffActorKey,
    },
  });

  emit({
    level: "info",
    trace_id: traceId,
    log_kind: "router_precursor",
    event: precursor.outcome || "unknown",
    data: {
      compliance: precursor.compliance,
      tenant_command: precursor.tenantCommand,
      staff_capture: precursor.staffCapture || null,
      staff_is: staffContext.isStaff,
      staff_actor_key: staffContext.staffActorKey,
      staff_reason: staffContext.reason,
      body_len: precursor.bodyTrim ? String(precursor.bodyTrim).length : 0,
    },
  });

  const inbound = normalizeInboundEventFromRouterParameter(routerParameter);
  /** GAS: # capture + staff intercept return before decideLane_. */
  const laneDecision =
    precursor.outcome === "STAFF_CAPTURE_HASH"
      ? {
          lane: "staffCapture",
          reason: "hash_prefix",
          mode: "MANAGER",
          trace: "lane_v1",
        }
      : precursor.outcome === "STAFF_LIFECYCLE_GATE"
        ? {
            lane: "staffOperational",
            reason: "staff_intercept_before_lane",
            mode: "STAFF",
            trace: "lane_v1",
          }
        : decideLane(inbound);
  await appendEventLog({
    traceId,
    log_kind: "router",
    event: "LANE_DECIDED",
    payload: { lane: laneDecision.lane, reason: laneDecision.reason, mode: laneDecision.mode },
  });

  emit({
    level: "info",
    trace_id: traceId,
    log_kind: "router_lane",
    event: laneDecision.lane,
    data: { reason: laneDecision.reason, mode: laneDecision.mode },
  });

  let staffRun = null;
  if (precursor.outcome === "STAFF_LIFECYCLE_GATE" && staffContext.staff) {
    staffRun = await handleStaffLifecycleCommand({
      traceId,
      staffActorKey: staffContext.staffActorKey,
      staffRow: staffContext.staff,
      routerParameter,
    });
  }

  let coreRun = null;
  const canEnterCore =
    coreEnabled() &&
    isDbConfigured() &&
    !staffRun &&
    !precursor.compliance &&
    !precursor.tenantCommand &&
    (precursor.outcome === "STAFF_CAPTURE_HASH" ||
      precursor.outcome === "PRECURSOR_EVALUATED");

  if (canEnterCore) {
    const isStaffCapture = precursor.outcome === "STAFF_CAPTURE_HASH";
    const bodyForCore = isStaffCapture
      ? String(
          (precursor.staffCapture && precursor.staffCapture.stripped) || ""
        ).trim()
      : String(routerParameter.Body || "").trim();
    coreRun = await handleInboundCore({
      traceId,
      routerParameter,
      mode: isStaffCapture ? "MANAGER" : "TENANT",
      bodyText: bodyForCore,
      staffActorKey: staffContext.staffActorKey,
    });
  }

  let outbound = null;
  const canTgOut =
    signal.channel === CHANNEL_TELEGRAM &&
    telegramOutboundEnabled() &&
    signal.transport &&
    signal.transport.chat_id;

  if (canTgOut && staffRun && staffRun.replyText) {
    outbound = await sendTelegramMessage({
      chatId: signal.transport.chat_id,
      text: staffRun.replyText,
      traceId,
    });
  } else if (canTgOut && coreRun && coreRun.replyText) {
    outbound = await sendTelegramMessage({
      chatId: signal.transport.chat_id,
      text: coreRun.replyText,
      traceId,
    });
  }

  let brain = "tenant_path";
  if (staffRun && staffRun.brain) {
    brain = staffRun.brain;
  } else if (coreRun && coreRun.brain) {
    brain = coreRun.brain;
  } else if (precursor.outcome === "STAFF_CAPTURE_HASH") {
    brain = "staff_capture_pending_core";
  } else if (precursor.outcome === "STAFF_LIFECYCLE_GATE") {
    brain = staffContext.staff ? "staff_gate_no_handler" : "staff_gate_missing_staff_row";
  }

  return res.status(200).json({
    ok: true,
    brain,
    lane: laneDecision,
    core: coreRun
      ? {
          brain: coreRun.brain,
          reply: coreRun.replyText || "",
          draft: coreRun.draft || null,
          finalize: coreRun.finalize || null,
        }
      : null,
    precursor: {
      outcome: precursor.outcome,
      compliance: precursor.compliance,
      tenantCommand: precursor.tenantCommand,
      staffCapture: precursor.staffCapture || null,
      staffGate: precursor.staffGate || null,
      staffContext: {
        isStaff: staffContext.isStaff,
        staffActorKey: staffContext.staffActorKey,
        reason: staffContext.reason,
      },
    },
    staff: staffRun
      ? {
          brain: staffRun.brain,
          reply: staffRun.replyText,
          resolution: staffRun.resolution || null,
          outcome: staffRun.outcome != null ? staffRun.outcome : undefined,
          db: staffRun.db || null,
        }
      : null,
    outbound: outbound
      ? { ok: outbound.ok, error: outbound.error || null }
      : { skipped: true },
  });
});

/**
 * Dev-only: resolve staff vs tenant from DB (same idea as GAS isStaff / router lane).
 * Disabled in production unless IDENTITY_API_ENABLED=1.
 */
app.get("/api/dev/resolve-actor", async (req, res) => {
  if (!identityApiEnabled()) {
    return res.status(404).json({ ok: false, error: "disabled" });
  }
  const phone = String(req.query.phone || "").trim();
  const out = await resolveActor(phone);
  emit({
    level: "info",
    trace_id: req.traceId,
    log_kind: "identity_resolve",
    event: out.lane,
    data: { phone: out.phoneE164, reason: out.reason },
  });
  res.json({ ok: true, ...out });
});

app.get("/health", async (req, res) => {
  const trace = createTrace({ traceId: req.traceId });
  trace.step("HEALTH", { path: "/health" });

  let db = { configured: isDbConfigured(), ok: null, error: null };
  if (db.configured) {
    const ping = await pingDb();
    db.ok = ping.ok;
    if (!ping.ok && ping.error) db.error = ping.error;
    trace.snap("db_ping", { configured: db.configured, ok: db.ok, error: db.error });
  }

  trace.perf("HEALTH");
  res.json({
    ok: true,
    service: "propera-v2",
    phase: 0,
    nodeEnv,
    uptimeSec: Math.floor(process.uptime()),
    traceId: trace.traceId,
    db,
  });
});

const server = app.listen(port, () => {
  boot("listen", { port, nodeEnv });
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${port} is already in use (another app or an old "npm start").\n\n` +
        `Fix options:\n` +
        `  1) Stop the other process, then run npm start again.\n` +
        `  2) Use another port: e.g. PORT=8081 in .env (not 3000 — reserved for propera-app)\n\n` +
        `Windows — find PID on port ${port}:\n` +
        `  netstat -ano | findstr :${port}\n` +
        `Then end that PID (only if it is node/propera):  taskkill /PID <pid> /F\n`
    );
    process.exit(1);
  }
  throw err;
});
