/**
 * Phase 2 / 4 — Load maintenance core dispatch context: actor validation → CORE_ENTER → session → gates → fastDraft.
 * Returns either an early **`result`** or a **`ctx`** payload for **`runCoreMaintenanceFastPath`** / **`runCoreMaintenanceMultiTurn`**.
 */

const { getSupabase } = require("../../db/supabase");
const { appendEventLog } = require("../../dal/appendEventLog");
const { emitTimed } = require("../../logging/structuredLog");
const {
  upsertIntakeSession,
  clearIntakeSessionDraft,
  setScheduleWaitAfterFinalize,
  listPropertiesForMenu,
} = require("../../dal/intakeSession");
const { parseMediaSignalsJson } = require("../shared/mediaSignalRuntime");
const {
  updateDraftFields,
  deleteDraft,
  setScheduleWaitAfterFinalizeDraft,
} = require("../../dal/staffCaptureDraft");
const { hasProblemSignal } = require("./splitIssueGroups");
const { outgateMeta } = require("./handleInboundCoreMechanics");
const {
  resolveTenantVerificationIfPending,
  resolveAttachClarifyIfPending,
  handleScheduleReplyIfExpected,
} = require("./handleInboundCoreGates");
const {
  loadPropertyCodesUpper,
  hasClarifyingStaffMediaSignal,
} = require("./coreMaintenanceShared");
const { buildFastDraftForMaintenanceCore } = require("./coreMaintenancePortalDraft");
const { resolveStaffCaptureBodyAndSession } = require("./coreMaintenanceStaffCapture");
const { parseMediaJson } = require("../shared/mediaPayload");
const { isAudioMediaItem } = require("../../media/audioTranscriptionProvider");

/**
 * @typedef {object} MaintenanceCoreDispatchCtx
 * @property {string} traceId
 * @property {number | null} traceStartMs
 * @property {'TENANT'|'MANAGER'} mode
 * @property {Record<string, string | undefined>} p
 * @property {boolean} isStaffCapture
 * @property {object} fastDraft
 * @property {string} effectiveBody
 * @property {string} attachClarifyOutcomePass
 * @property {object} sessionAtStart
 * @property {Set<string>} known
 * @property {object[]} propertiesList
 * @property {unknown[]} mediaSignals
 * @property {string} canonicalBrainActorKey
 * @property {string} staffActorKey
 * @property {string} telegramUpdateId
 * @property {import("@supabase/supabase-js").SupabaseClient} sb
 * @property {string} draftOwnerKey
 * @property {() => object} staffMeta
 * @property {() => Promise<unknown>} clearIntakeLike
 * @property {(row: object) => Promise<unknown>} saveIntakeLike
 * @property {(opts: object) => Promise<unknown>} setScheduleWaitLike
 * @property {boolean} suppressIssueFromClarifyMedia
 * @property {(n: number) => void} setDraftSeqActive
 * @property {number | null} draftSeqActive
 */

/**
 * @param {object} o — same as `handleInboundCore(o)`
 * @returns {Promise<
 *   | { kind: 'return'; result: object; coreEntered: boolean }
 *   | { kind: 'dispatch'; ctx: MaintenanceCoreDispatchCtx; coreEntered: true }
 * >}
 */
async function buildMaintenanceCoreDispatchContext(o) {
  const traceId = o.traceId || "";
  const traceStartMs =
    o.traceStartMs != null && isFinite(Number(o.traceStartMs))
      ? Number(o.traceStartMs)
      : null;
  const mode = o.mode === "MANAGER" ? "MANAGER" : "TENANT";
  const isStaffCapture = o.isStaffCapture === true;
  const p = o.routerParameter || {};
  const transportActorKey =
    String(p._phoneE164 || "").trim() || String(p.From || "").trim();
  const explicitCanonical = String(
    o.canonicalBrainActorKey != null && o.canonicalBrainActorKey !== ""
      ? o.canonicalBrainActorKey
      : p._canonicalBrainActorKey || ""
  ).trim();
  const canonicalBrainActorKey = isStaffCapture
    ? explicitCanonical
    : explicitCanonical || transportActorKey;
  let bodyText = String(o.bodyText != null ? o.bodyText : p.Body || "").trim();
  const mediaSignals = parseMediaSignalsJson(p._mediaSignalsJson);
  let staffMeta = () => ({});
  const staffActorKey = String(o.staffActorKey || "").trim();
  const telegramUpdateId = String(p._telegramUpdateId || "").trim();

  const sb = getSupabase();
  if (!sb) {
    await appendEventLog({
      traceId,
      event: "CORE_SKIP_NO_DB",
      payload: { mode },
    });
    return {
      kind: "return",
      coreEntered: false,
      result: {
        ok: false,
        brain: "core_skip",
        replyText: "Database is not configured; cannot create tickets in V2.",
        ...staffMeta(),
        ...outgateMeta("MAINTENANCE_ERROR_DB"),
      },
    };
  }

  if (isStaffCapture && !explicitCanonical) {
    return {
      kind: "return",
      coreEntered: false,
      result: {
        ok: false,
        brain: "core_skip",
        replyText: "Missing canonical brain actor key for staff capture.",
        ...staffMeta(),
        ...outgateMeta("MAINTENANCE_ERROR_NO_ACTOR"),
      },
    };
  }

  if (!canonicalBrainActorKey) {
    return {
      kind: "return",
      coreEntered: false,
      result: {
        ok: false,
        brain: "core_skip",
        replyText: "Missing actor (From / _phoneE164).",
        ...staffMeta(),
        ...outgateMeta("MAINTENANCE_ERROR_NO_ACTOR"),
      },
    };
  }

  if (!bodyText) {
    const mediaList = parseMediaJson(p._mediaJson || "");
    const hadAudio = mediaList.some((m) => isAudioMediaItem(m));
    const anyTranscript = mediaList.some((m) => String(m.transcript || "").trim());
    if (hadAudio && !anyTranscript) {
      const replyText =
        mode === "MANAGER"
          ? "I could not understand the voice note clearly. Please resend it or type the ticket details after #."
          : "I could not understand the audio clearly. Please resend it or type the issue in a short message.";
      await appendEventLog({
        traceId,
        event: "CORE_AUDIO_TRANSCRIPTION_EMPTY",
        payload: { mode },
      });
      return {
        kind: "return",
        coreEntered: false,
        result: {
          ok: true,
          brain: "core_audio_clarify",
          replyText,
          ...staffMeta(),
          ...outgateMeta("MAINTENANCE_CLARIFY_AUDIO"),
        },
      };
    }
    await appendEventLog({ traceId, event: "CORE_SKIP_EMPTY_BODY", payload: { mode } });
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: "CORE_SKIP_EMPTY_BODY",
      data: { mode, crumb: "core_skip_empty_body" },
    });
    return {
      kind: "return",
      coreEntered: false,
      result: {
        ok: true,
        brain: "core_empty_body",
        replyText: "",
        ...staffMeta(),
        ...outgateMeta("OUTBOUND_SKIP_EMPTY"),
      },
    };
  }

  await appendEventLog({
    traceId,
    event: "CORE_ENTER",
    payload: { mode, body_len: bodyText.length },
  });
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: "CORE_ENTER",
    data: { mode, body_len: bodyText.length, crumb: "core_enter" },
  });

  const known = await loadPropertyCodesUpper(sb);
  const propertiesList = await listPropertiesForMenu();

  const draftOwnerKey = isStaffCapture ? explicitCanonical : canonicalBrainActorKey;

  let draftSeqActive = null;
  let sessionAtStart;
  let staffTypedPayload = "";
  const sessionResolved = await resolveStaffCaptureBodyAndSession({
    isStaffCapture,
    explicitCanonical,
    draftOwnerKey,
    transportActorKey,
    mode,
    traceStartMs,
    traceId,
    staffRow: o.staffRow,
    staffDraftParsed: o.staffDraftParsed,
    sb,
    bodyText,
    canonicalBrainActorKey,
    staffMeta,
  });
  if (!sessionResolved.ok) {
    return { kind: "return", coreEntered: true, result: sessionResolved.result };
  }
  bodyText = sessionResolved.bodyText;
  sessionAtStart = sessionResolved.sessionAtStart;
  draftSeqActive = sessionResolved.draftSeqActive;
  staffTypedPayload = sessionResolved.staffTypedPayload;

  staffMeta = () =>
    isStaffCapture && draftSeqActive != null ? { staffDraftSeq: draftSeqActive } : {};

  async function clearIntakeLike() {
    if (isStaffCapture) {
      return deleteDraft(sb, draftOwnerKey, draftSeqActive);
    }
    return clearIntakeSessionDraft(canonicalBrainActorKey);
  }

  async function saveIntakeLike(row) {
    if (isStaffCapture) {
      const { phone_e164: _p, lane: _l, ...rest } = row;
      return updateDraftFields(sb, draftOwnerKey, draftSeqActive, rest);
    }
    return upsertIntakeSession(row);
  }

  async function setScheduleWaitLike(opts) {
    if (isStaffCapture) {
      return setScheduleWaitAfterFinalizeDraft(sb, draftOwnerKey, draftSeqActive, opts);
    }
    return setScheduleWaitAfterFinalize(canonicalBrainActorKey, opts);
  }

  const verifyGate = await resolveTenantVerificationIfPending({
    mode,
    sb,
    canonicalBrainActorKey,
    bodyText,
    traceId,
    traceStartMs,
  });
  if (verifyGate.handled) {
    return { kind: "return", coreEntered: true, result: verifyGate.result };
  }

  let effectiveBody = bodyText;
  let attachClarifyOutcomePass = "";
  const attachGate = await resolveAttachClarifyIfPending({
    sb,
    traceId,
    traceStartMs,
    canonicalBrainActorKey,
    bodyText,
    isStaffCapture,
    draftOwnerKey,
    draftSeqActive,
    known,
    propertiesList,
    staffMetaFn: staffMeta,
    clearIntakeLike,
    saveIntakeLike,
  });
  if (attachGate.handled) {
    return { kind: "return", coreEntered: true, result: attachGate.result };
  }
  if (attachGate.patch) {
    effectiveBody = attachGate.patch.effectiveBody;
    attachClarifyOutcomePass = attachGate.patch.attachClarifyOutcomePass;
  }

  const scheduleGate = await handleScheduleReplyIfExpected({
    sessionAtStart,
    effectiveBody,
    known,
    propertiesList,
    mediaSignals,
    traceId,
    traceStartMs,
    isStaffCapture,
    staffMetaFn: staffMeta,
    clearIntakeLike,
    sb,
    canonicalBrainActorKey,
  });
  if (scheduleGate.handled) {
    return { kind: "return", coreEntered: true, result: scheduleGate.result };
  }

  const draftBuilt = await buildFastDraftForMaintenanceCore({
    mode,
    p,
    known,
    propertiesList,
    traceId,
    traceStartMs,
    effectiveBody,
    mediaSignals,
    staffMeta,
  });
  if (!draftBuilt.ok) {
    return { kind: "return", coreEntered: true, result: draftBuilt.result };
  }
  const fastDraft = draftBuilt.fastDraft;
  const suppressIssueFromClarifyMedia =
    isStaffCapture &&
    hasClarifyingStaffMediaSignal(mediaSignals) &&
    !hasProblemSignal(staffTypedPayload);
  if (suppressIssueFromClarifyMedia) {
    fastDraft.issueText = "";
    fastDraft.structuredIssues = null;
    if (fastDraft.openerNext === "SCHEDULE") fastDraft.openerNext = "";
  }

  /** @type {MaintenanceCoreDispatchCtx} */
  const ctx = {
    traceId,
    traceStartMs,
    mode,
    p,
    isStaffCapture,
    fastDraft,
    effectiveBody,
    attachClarifyOutcomePass,
    sessionAtStart,
    known,
    propertiesList,
    mediaSignals,
    canonicalBrainActorKey,
    staffActorKey,
    telegramUpdateId,
    sb,
    draftOwnerKey,
    staffMeta,
    clearIntakeLike,
    saveIntakeLike,
    setScheduleWaitLike,
    suppressIssueFromClarifyMedia,
    setDraftSeqActive: (n) => {
      draftSeqActive = n;
    },
    get draftSeqActive() {
      return draftSeqActive;
    },
  };

  return { kind: "dispatch", coreEntered: true, ctx };
}

module.exports = { buildMaintenanceCoreDispatchContext };
