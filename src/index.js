/**
 * Propera V2 — minimal HTTP shell (Phase 0).
 * GAS + Sheets remain production until explicit cutover.
 */
const express = require("express");
const {
  port,
  nodeEnv,
  identityApiEnabled,
  lifecycleCronSecret,
} = require("./config/env");
const { createTrace } = require("./trace/createTrace");
const { isDbConfigured, pingDb, getSupabase } = require("./db/supabase");
const { processDueLifecycleTimers } = require("./jobs/processLifecycleTimers");
const { requestContext } = require("./middleware/requestContext");
const { boot, emit } = require("./logging/structuredLog");
const {
  buildTelegramInboundCtx,
  previewText,
  runWithInboundLogCtx,
  buildTwilioInboundCtx,
} = require("./logging/inboundLogContext");
const { resolveActor } = require("./identity/resolveActor");
const { verifyTelegramWebhookSecret } = require("./adapters/telegram/verifyWebhookSecret");
const { normalizeTelegramUpdate } = require("./adapters/telegram/normalizeTelegramUpdate");
const { enrichTelegramMediaWithOcr } = require("./adapters/telegram/enrichTelegramMediaWithOcr");
const { tryConsumeUpdateId } = require("./adapters/telegram/dedupeUpdateId");
const { buildRouterParameterFromTelegram } = require("./contracts/buildRouterParameterFromTelegram");
const { buildRouterParameterFromTwilio } = require("./contracts/buildRouterParameterFromTwilio");
const { buildRouterParameterFromPortal } = require("./contracts/buildRouterParameterFromPortal");
const { verifyPortalRequest } = require("./portal/portalAuth");
const { runInboundPipeline } = require("./inbound/runInboundPipeline");
const { registerDashboardRoutes } = require("./dashboard/registerDashboard");
const { registerPortalReadRoutes } = require("./portal/registerPortalRoutes");

const app = express();

app.use(express.json({ limit: "2mb" }));
const twilioForm = express.urlencoded({ extended: true });
app.use(requestContext);

registerDashboardRoutes(app);
registerPortalReadRoutes(app);

app.post("/internal/cron/lifecycle-timers", async (req, res) => {
  const secret = lifecycleCronSecret();
  const hdr = String(req.headers["x-propera-cron-secret"] || "").trim();
  if (!secret || hdr !== secret) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
  try {
    const out = await processDueLifecycleTimers(sb, { traceId: req.traceId });
    return res.json({ ok: true, ...out });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    "Propera V2 — GET /health | POST /webhooks/telegram | POST /webhooks/twilio | POST /webhooks/sms | POST /webhooks/portal | POST /internal/cron/lifecycle-timers | GET /api/portal/gas-compat?path=tickets|properties|tenants | GET /api/portal/tenants (+ POST PATCH DELETE roster) | GET /api/portal/program-templates program-runs POST program-runs PATCH program-lines/:id/complete|reopen | GET /dashboard + GET /api/ops/event-log + GET /api/ops/lifecycle-timers | dev: GET /api/dev/resolve-actor?phone=+1..."
  );
});

/**
 * Telegram adapter — RouterParameter → precursors → lane (GAS) → staff lifecycle (DB) or tenant path.
 * Compliance / SMS opt-out **do not** apply to Telegram — see `runInboundPipeline` + `transportCompliance.js`.
 */
app.post("/webhooks/telegram", async (req, res) => {
  const traceId = req.traceId;

  if (!verifyTelegramWebhookSecret(req)) {
    emit({
      level: "warn",
      trace_id: traceId,
      trace_start_ms: req.traceStartMs,
      log_kind: "telegram_webhook",
      event: "secret_mismatch",
      data: { crumb: "secret_mismatch" },
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
      trace_start_ms: req.traceStartMs,
      log_kind: "telegram_webhook",
      event: "skipped_no_user_message",
      data: { update_id: payload.update_id ?? null, crumb: "skipped_no_user_message" },
    });
    return res.status(200).json({ ok: true, ignored: true });
  }

  if (payload.update_id != null && !tryConsumeUpdateId(payload.update_id)) {
    emit({
      level: "info",
      trace_id: traceId,
      trace_start_ms: req.traceStartMs,
      log_kind: "telegram_webhook",
      event: "deduped",
      data: { update_id: payload.update_id, crumb: "deduped" },
    });
    return res.status(200).json({ ok: true, deduped: true });
  }

  const signal = normalizeTelegramUpdate(payload);
  if (!signal) {
    return res.status(200).json({ ok: true, ignored: true });
  }
  if (signal.body && Array.isArray(signal.body.media) && signal.body.media.length > 0) {
    signal.body.media = await enrichTelegramMediaWithOcr(signal.body.media);
  }

  let routerParameter;
  try {
    routerParameter = buildRouterParameterFromTelegram(signal, payload);
  } catch (err) {
    emit({
      level: "error",
      trace_id: traceId,
      trace_start_ms: req.traceStartMs,
      log_kind: "router_contract",
      event: "build_parameter_failed",
      data: {
        error: String(err && err.message ? err.message : err),
        crumb: "router_parameter_build_failed",
      },
    });
    return res.status(200).json({ ok: true, error: "router_parameter_build_failed" });
  }

  const inboundCtx = buildTelegramInboundCtx(signal, routerParameter);

  return runWithInboundLogCtx(inboundCtx, async () => {
    emit({
      level: "info",
      trace_id: traceId,
      trace_start_ms: req.traceStartMs,
      log_kind: "telegram_webhook",
      event: "INBOUND_THREAD_START",
      data: {
        crumb: "inbound_thread_start",
        thread_start: true,
        trace_id: traceId,
        actor_key: inboundCtx.actor_key,
        chat_id: inboundCtx.chat_id,
        update_id: inboundCtx.update_id,
      },
    });

    emit({
      level: "info",
      trace_id: traceId,
      trace_start_ms: req.traceStartMs,
      log_kind: "telegram_adapter",
      event: "normalized",
      data: {
        channel: signal.channel,
        update_id: signal.transport && signal.transport.update_id,
        chat_id: signal.transport && signal.transport.chat_id,
        text_len: signal.body && signal.body.text ? String(signal.body.text).length : 0,
        crumb: "signal_normalized",
      },
    });

    const result = await runInboundPipeline({
      traceId,
      traceStartMs: req.traceStartMs,
      routerParameter,
      transportChannel: "telegram",
      telegramSignal: signal,
      logKind: "telegram_webhook",
    });

    const replyForPreview =
      (result.staffRun && result.staffRun.replyText) ||
      (result.complianceRun && result.complianceRun.replyText) ||
      (result.coreRun && result.coreRun.replyText) ||
      "";

    emit({
      level: "info",
      trace_id: traceId,
      trace_start_ms: req.traceStartMs,
      log_kind: "telegram_webhook",
      event: "request_complete",
      data: {
        crumb: "webhook_request_complete",
        thread_end: true,
        trace_id: traceId,
        actor_key: inboundCtx.actor_key,
        chat_id: inboundCtx.chat_id,
        update_id: inboundCtx.update_id,
        brain: result.brain,
        lane: result.laneDecision.lane,
        lane_mode: result.laneDecision.mode,
        total_ms: Date.now() - req.traceStartMs,
        inbound_preview: inboundCtx.inbound_text_preview,
        reply_preview: replyForPreview ? previewText(replyForPreview, 120) : "",
        outbound_sent: !!(result.outbound && result.outbound.ok),
      },
    });

    return res.status(200).json(result.json);
  });
});

/**
 * Twilio SMS + WhatsApp (same inbound format; `From` is `whatsapp:+…` for WA).
 * Compliance STOP/START/HELP + `sms_opt_out` **SMS only** — WhatsApp uses the same pipeline without compliance side effects.
 */
async function handleTwilioWebhook(req, res) {
  const traceId = req.traceId;
  const routerParameter = buildRouterParameterFromTwilio(req.body || {});
  const from = String(routerParameter.From || "");
  const isWa = from.toLowerCase().indexOf("whatsapp:") === 0;
  const transportChannel = isWa ? "whatsapp" : "sms";
  const inboundCtx = buildTwilioInboundCtx(routerParameter);

  return runWithInboundLogCtx(inboundCtx, async () => {
    const result = await runInboundPipeline({
      traceId,
      traceStartMs: req.traceStartMs,
      routerParameter,
      transportChannel,
      logKind: isWa ? "whatsapp_webhook" : "sms_webhook",
    });
    return res.status(200).type("application/json").send(JSON.stringify(result.json));
  });
}

app.get("/webhooks/twilio", (_req, res) => {
  res.type("text/plain").send("ok");
});

app.post("/webhooks/twilio", twilioForm, handleTwilioWebhook);
app.post("/webhooks/sms", twilioForm, handleTwilioWebhook);

/**
 * Portal / PM structured ingress — same brain as messaging; replies in JSON (no SMS/TG send).
 */
app.post("/webhooks/portal", async (req, res) => {
  if (!verifyPortalRequest(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  try {
    const routerParameter = buildRouterParameterFromPortal(req.body || {});
    const result = await runInboundPipeline({
      traceId: req.traceId,
      traceStartMs: req.traceStartMs,
      routerParameter,
      transportChannel: "portal",
      telegramSignal: null,
      logKind: "portal_webhook",
    });
    return res.status(200).json(result.json);
  } catch (err) {
    emit({
      level: "error",
      trace_id: req.traceId,
      log_kind: "portal_webhook",
      event: "portal_inbound_failed",
      data: { error: String(err && err.message ? err.message : err) },
    });
    return res.status(400).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
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
    trace_start_ms: req.traceStartMs,
    log_kind: "identity_resolve",
    event: out.lane,
    data: { phone: out.phoneE164, reason: out.reason, crumb: "identity_resolve" },
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
