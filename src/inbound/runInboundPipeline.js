/**
 * Shared router → staff / compliance (SMS-only) / core — GAS `handleInboundRouter_` slice.
 * Compliance + `sms_opt_out` **only** when `transportChannel === "sms"` (TCPA-style SMS).
 */

const { resolveStaffContextFromRouterParameter } = require("../identity/resolveStaffContext");
const { upsertTelegramChatLink } = require("../identity/upsertTelegramChatLink");
const { evaluateRouterPrecursor } = require("../brain/router/evaluateRouterPrecursor");
const { normalizeInboundEventFromRouterParameter } = require("../brain/router/normalizeInboundEvent");
const {
  parseMediaJson,
  composeInboundTextWithMedia,
} = require("../brain/shared/mediaPayload");
const { enrichTwilioMediaWithOcr } = require("../adapters/twilio/enrichTwilioMediaWithOcr");
const { appendEventLog } = require("../dal/appendEventLog");
const { isDbConfigured, getSupabase } = require("../db/supabase");
const {
  resolveCanonicalBrainActorKey,
  canonicalForNonStaff,
} = require("../signal/resolveCanonicalBrainActorKey");
const { setSmsOptOut, isSmsOptedOut } = require("../dal/smsOptOut");
const { handleStaffLifecycleCommand } = require("../brain/staff/handleStaffLifecycleCommand");
const { tryPortalPmTicketMutation } = require("../dal/portalTicketMutations");
const { handleInboundCore } = require("../brain/core/handleInboundCore");
const {
  buildOutboundIntent,
  renderOutboundIntent,
  dispatchOutbound,
} = require("../outgate");
const { messageSpecForComplianceBrain } = require("../outgate/messageSpecs");
const { CHANNEL_TELEGRAM } = require("../signal/inboundSignal");
const { coreEnabled } = require("../config/env");
const { complianceSmsOnly } = require("./transportCompliance");
const {
  getEffectiveCompliance,
  buildLaneDecision,
  buildNonMaintenanceLaneStub,
  shouldShowNonMaintenanceLaneStub,
  shouldInvokeStaffLifecycle,
  shouldRunSmsComplianceBranch,
  shouldEvaluateSmsSuppress,
  computeCanEnterCore,
  isStaffCaptureHash,
  resolveDefaultBrain,
} = require("./routeInboundDecision");
const { previewText } = require("../logging/inboundLogContext");
const { emit } = require("../logging/structuredLog");
const {
  parseStaffCapDraftIdFromStripped,
  tagStaffCaptureReply,
} = require("../dal/staffCaptureDraft");

/**
 * @param {{ staffRun?: object | null, complianceRun?: object | null, stubRun?: object | null, coreRun?: object | null }} o
 * @returns {string}
 */
function resolveOutboundIntentType(o) {
  const { staffRun, complianceRun, stubRun, coreRun } = o || {};
  if (complianceRun && complianceRun.brain) {
    const b = String(complianceRun.brain);
    if (b === "compliance_stop") return "COMPLIANCE_STOP";
    if (b === "compliance_start") return "COMPLIANCE_START";
    if (b === "compliance_help") return "COMPLIANCE_HELP";
    return "COMPLIANCE_REPLY";
  }
  if (staffRun && staffRun.brain) return `STAFF_${String(staffRun.brain)}`;
  if (staffRun) return "STAFF_REPLY";
  if (stubRun && stubRun.brain) {
    const b = String(stubRun.brain);
    if (b === "lane_stub_vendor") return "STUB_VENDOR_LANE";
    if (b === "lane_stub_system") return "STUB_SYSTEM_LANE";
    return "STUB_LANE";
  }
  if (coreRun && coreRun.brain) return `CORE_${String(coreRun.brain)}`;
  if (coreRun) return "CORE_REPLY";
  return "INBOUND_REPLY";
}

/**
 * @param {object} o
 * @param {string} o.traceId
 * @param {number} [o.traceStartMs]
 * @param {Record<string, string>} o.routerParameter
 * @param {'sms' | 'whatsapp' | 'telegram' | 'portal'} o.transportChannel
 * @param {object} [o.telegramSignal] — required for Telegram outbound + chat link
 * @param {string} [o.logKind] — structured log kind prefix
 */
async function runInboundPipeline(o) {
  const traceId = o.traceId || "";
  const traceStartMs = o.traceStartMs != null ? o.traceStartMs : Date.now();
  const routerParameter = o.routerParameter || {};
  const transportChannel = String(o.transportChannel || "telegram").toLowerCase();
  const signal = o.telegramSignal || null;
  const logKind = String(o.logKind || "inbound").trim() || "inbound";

  if (transportChannel === "sms" || transportChannel === "whatsapp") {
    const mediaArr = parseMediaJson(routerParameter._mediaJson);
    if (mediaArr.length) {
      const enriched = await enrichTwilioMediaWithOcr(mediaArr);
      routerParameter._mediaJson = JSON.stringify(enriched);
    }
  }

  const smsCompliance = complianceSmsOnly(transportChannel);

  if (signal && signal.channel === CHANNEL_TELEGRAM) {
    await upsertTelegramChatLink(signal, traceId);
  }

  const staffContext = await resolveStaffContextFromRouterParameter(routerParameter);
  const transportActorKey =
    String(routerParameter._phoneE164 || "").trim() ||
    String(routerParameter.From || "").trim();
  if (isDbConfigured()) {
    const sbCanon = getSupabase();
    if (sbCanon) {
      routerParameter._canonicalBrainActorKey = await resolveCanonicalBrainActorKey({
        sb: sbCanon,
        routerParameter,
        staffRow: staffContext.staff || null,
        transportActorKey,
        isStaff: staffContext.isStaff === true,
      });
    } else {
      routerParameter._canonicalBrainActorKey = transportActorKey;
    }
  } else {
    routerParameter._canonicalBrainActorKey = staffContext.isStaff
      ? transportActorKey
      : canonicalForNonStaff(transportActorKey);
  }

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
    trace_start_ms: traceStartMs,
    log_kind: logKind,
    event: precursor.outcome || "unknown",
    data: {
      compliance: precursor.compliance,
      compliance_sms_only: smsCompliance,
      tenant_command: precursor.tenantCommand,
      staff_capture: precursor.staffCapture || null,
      staff_is: staffContext.isStaff,
      staff_actor_key: staffContext.staffActorKey,
      transport: transportChannel,
      crumb: "router_precursor",
    },
  });

  if (
    precursor.outcome === "STAFF_CAPTURE_HASH" &&
    staffContext.isStaff
  ) {
    const canon = String(routerParameter._canonicalBrainActorKey || "").trim();
    emit({
      level: "info",
      trace_id: traceId,
      trace_start_ms: traceStartMs,
      log_kind: logKind,
      event: "STAFF_CAPTURE_IDENTITY_DIAG",
      data: {
        crumb: "staff_capture_identity_diag",
        transport_channel: transportChannel,
        transport_actor_key: transportActorKey,
        canonical_brain_actor_key: canon,
        staff_id:
          staffContext.staff && staffContext.staff.staff_id
            ? String(staffContext.staff.staff_id)
            : "",
        draft_owner_key_expected: canon,
      },
    });
  }

  const effectiveCompliance = getEffectiveCompliance(smsCompliance, precursor);

  const inbound = normalizeInboundEventFromRouterParameter(routerParameter);
  const laneDecision = buildLaneDecision(precursor, inbound, staffContext);

  await appendEventLog({
    traceId,
    log_kind: "router",
    event: "LANE_DECIDED",
    payload: { lane: laneDecision.lane, reason: laneDecision.reason, mode: laneDecision.mode },
  });

  emit({
    level: "info",
    trace_id: traceId,
    trace_start_ms: traceStartMs,
    log_kind: logKind,
    event: laneDecision.lane,
    data: { reason: laneDecision.reason, mode: laneDecision.mode, crumb: "lane_decided" },
  });

  let staffRun = null;
  // Portal webhook is token-gated in `index.js`; PM saves must persist even when the
  // actor phone is not linked in `staff` (common for portal-only PM logins).
  // Same `Update <HUMAN_ID> …` parser for **staff** on Telegram / SMS / WhatsApp so
  // ticket fields (e.g. unit) can be corrected after `#` capture finalizes (draft row is gone).
  if (isDbConfigured()) {
    const staffPmChannel =
      transportChannel === "portal" ||
      ((transportChannel === "telegram" ||
        transportChannel === "whatsapp" ||
        transportChannel === "sms") &&
        staffContext &&
        staffContext.isStaff);
    if (staffPmChannel) {
      staffRun = await tryPortalPmTicketMutation({
        traceId,
        traceStartMs,
        routerParameter,
        staffAmendContext:
          staffContext && staffContext.isStaff && staffContext.staff
            ? {
                staffId: String(staffContext.staff.staff_id || "").trim(),
                staffActorKey: String(staffContext.staffActorKey || "").trim(),
              }
            : null,
      });
    }
  }
  if (!staffRun && shouldInvokeStaffLifecycle(precursor, staffContext)) {
    staffRun = await handleStaffLifecycleCommand({
      traceId,
      staffActorKey: staffContext.staffActorKey,
      staffRow: staffContext.staff,
      routerParameter,
    });
  }

  let complianceRun = null;
  const actorFrom = String(routerParameter.From || "").trim();
  if (shouldRunSmsComplianceBranch(smsCompliance, staffRun, precursor, actorFrom)) {
    const c = precursor.compliance;
    if (c === "STOP") {
      await setSmsOptOut(actorFrom, true);
      await appendEventLog({
        traceId,
        log_kind: "router",
        event: "SMS_OPTOUT_STOP",
        payload: { actor_key: actorFrom, channel: "sms" },
      });
      complianceRun = {
        brain: "compliance_stop",
        replyText:
          "You have been unsubscribed from maintenance SMS/notifications. Reply START to resubscribe.",
      };
    } else if (c === "START") {
      await setSmsOptOut(actorFrom, false);
      await appendEventLog({
        traceId,
        log_kind: "router",
        event: "SMS_OPTOUT_START",
        payload: { actor_key: actorFrom, channel: "sms" },
      });
      complianceRun = {
        brain: "compliance_start",
        replyText: "You have been resubscribed. How can we help?",
      };
    } else if (c === "HELP") {
      await appendEventLog({
        traceId,
        log_kind: "router",
        event: "SMS_HELP",
        payload: { actor_key: actorFrom, channel: "sms" },
      });
      complianceRun = {
        brain: "compliance_help",
        replyText:
          "Propera maintenance: describe the issue, building, and unit. Reply STOP to opt out, START to opt back in.",
      };
    }
  }

  let suppressedRun = null;
  if (
    shouldEvaluateSmsSuppress({
      smsCompliance,
      staffRun,
      complianceRun,
      precursor,
      actorFrom,
    })
  ) {
    if (isDbConfigured()) {
      const opted = await isSmsOptedOut(actorFrom);
      if (opted) {
        suppressedRun = { brain: "router_opted_out" };
        await appendEventLog({
          traceId,
          log_kind: "router",
          event: "ROUTER_SUPPRESS",
          payload: { actor_key: actorFrom, opted_out: true, channel: "sms" },
        });
        emit({
          level: "info",
          trace_id: traceId,
          trace_start_ms: traceStartMs,
          log_kind: logKind,
          event: "ROUTER_SUPPRESS",
          data: { actor_key: actorFrom, crumb: "router_opted_out" },
        });
      }
    }
  }

  /** Phase 20-C — vendor/system lanes do not enter maintenance core. */
  let stubRun = null;
  if (
    shouldShowNonMaintenanceLaneStub({
      precursor,
      laneDecision,
      staffRun,
      complianceRun,
      suppressedRun,
    })
  ) {
    stubRun = buildNonMaintenanceLaneStub(laneDecision.lane);
    if (stubRun) {
      await appendEventLog({
        traceId,
        log_kind: "router",
        event: "LANE_STUB",
        payload: { lane: laneDecision.lane, brain: stubRun.brain },
      });
    }
  }

  let coreRun = null;
  const canEnterCore = computeCanEnterCore({
    laneDecision,
    coreEnabledFlag: coreEnabled(),
    dbConfigured: isDbConfigured(),
    staffRun,
    complianceRun,
    suppressedRun,
    effectiveCompliance,
    precursor,
    transportChannel,
    staffContext: {
      isStaff: staffContext && staffContext.isStaff === true,
    },
  });

  if (canEnterCore) {
    const isStaffCapture = isStaffCaptureHash(precursor);
    const bodyBase = isStaffCapture
      ? String(
          (precursor.staffCapture && precursor.staffCapture.stripped) || ""
        ).trim()
      : String(routerParameter.Body || "").trim();
    const mediaForCore = parseMediaJson(routerParameter._mediaJson);
    const staffDraftParsed = isStaffCapture
      ? parseStaffCapDraftIdFromStripped(bodyBase)
      : null;
    const textForMediaCompose = isStaffCapture
      ? staffDraftParsed && staffDraftParsed.draftSeq != null
        ? staffDraftParsed.rest
        : bodyBase
      : bodyBase;
    const bodyForCore = composeInboundTextWithMedia(
      textForMediaCompose,
      mediaForCore,
      1400
    );
    coreRun = await handleInboundCore({
      traceId,
      traceStartMs,
      routerParameter,
      mode: isStaffCapture ? "MANAGER" : "TENANT",
      bodyText: bodyForCore,
      staffActorKey: staffContext.staffActorKey,
      staffRow: staffContext.staff || null,
      isStaffCapture,
      staffDraftParsed: staffDraftParsed || undefined,
      canonicalBrainActorKey: String(routerParameter._canonicalBrainActorKey || "").trim(),
    });
    if (
      coreRun &&
      coreRun.staffDraftSeq != null &&
      coreRun.replyText &&
      String(coreRun.replyText).trim()
    ) {
      coreRun.replyText = tagStaffCaptureReply(
        coreRun.staffDraftSeq,
        coreRun.replyText
      );
    }
  }

  const replyText =
    (staffRun && staffRun.replyText) ||
    (complianceRun && complianceRun.replyText) ||
    (coreRun && coreRun.replyText) ||
    (stubRun && stubRun.replyText) ||
    "";

  const intentType = resolveOutboundIntentType({
    staffRun,
    complianceRun,
    stubRun,
    coreRun,
  });
  const audience =
    staffRun && staffRun.replyText ? "staff" : replyText ? "tenant" : "unknown";

  const messageSpec = complianceRun
    ? messageSpecForComplianceBrain(complianceRun.brain)
    : null;

  const facts = {};
  if (coreRun && coreRun.outgate) {
    facts.coreOutgate = coreRun.outgate;
  }

  const intent = buildOutboundIntent({
    intentType,
    audience,
    replyText,
    traceId,
    facts,
  });

  const rendered = renderOutboundIntent({ intent, messageSpec });

  let outbound = null;
  if (rendered.body) {
    outbound = await dispatchOutbound({
      traceId,
      transportChannel,
      body: rendered.body,
      telegramSignal: signal,
      twilioTo: actorFrom,
      dispatchMeta: {
        intentType,
        outgate: rendered.meta,
      },
    });
  }

  const brain = resolveDefaultBrain({
    staffRun,
    complianceRun,
    suppressedRun,
    stubRun,
    coreRun,
    precursor,
    staffContext,
  });

  /** Portal PM DB mutations set `staffRun.ok === false` — surface as top-level `ok` for HTTP clients. */
  const pipelineHttpOk = !(staffRun && staffRun.ok === false);

  emit({
    level: "info",
    trace_id: traceId,
    trace_start_ms: traceStartMs,
    log_kind: logKind,
    event: "request_complete",
    data: {
      crumb: "inbound_request_complete",
      trace_id: traceId,
      brain,
      lane: laneDecision.lane,
      transport: transportChannel,
      reply_preview: replyText ? previewText(replyText, 120) : "",
      outbound_sent: !!(outbound && outbound.ok),
    },
  });

  return {
    brain,
    laneDecision,
    staffRun,
    coreRun,
    complianceRun,
    suppressedRun,
    stubRun,
    precursor,
    staffContext,
    outbound,
    json: {
      ok: pipelineHttpOk,
      brain,
      transport: transportChannel,
      lane: laneDecision,
      core: coreRun
        ? {
            brain: coreRun.brain,
            reply: coreRun.replyText || "",
            draft: coreRun.draft || null,
            finalize: coreRun.finalize || null,
            outgate: coreRun.outgate || null,
          }
        : null,
      precursor: {
        outcome: precursor.outcome,
        compliance: precursor.compliance,
        compliance_applied: smsCompliance,
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
      compliance: complianceRun,
      stub: stubRun
        ? { brain: stubRun.brain, reply: stubRun.replyText || "" }
        : null,
      router_suppressed: suppressedRun ? true : false,
      outbound: outbound
        ? {
            ok: outbound.ok,
            error: outbound.error || null,
            outgate: rendered.body ? rendered.meta : null,
          }
        : { skipped: true, outgate: rendered.body ? rendered.meta : null },
    },
  };
}

module.exports = { runInboundPipeline };
