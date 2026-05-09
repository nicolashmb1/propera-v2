/**
 * Phase 4 — staff `#` capture: canonical invariant, structured log, draft turn resolve vs tenant session load.
 */

const { emitTimed } = require("../../logging/structuredLog");
const { getIntakeSession } = require("../../dal/intakeSession");
const {
  parseStaffCapDraftIdFromStripped,
  resolveStaffCaptureDraftTurn,
} = require("../../dal/staffCaptureDraft");
const { outgateMeta } = require("./handleInboundCoreMechanics");

/**
 * @param {object} o
 * @param {boolean} o.isStaffCapture
 * @param {string} o.explicitCanonical
 * @param {string} o.draftOwnerKey
 * @param {string} o.transportActorKey
 * @param {'TENANT'|'MANAGER'} o.mode
 * @param {number | null} o.traceStartMs
 * @param {string} o.traceId
 * @param {{ staff_id?: string } | null | undefined} o.staffRow
 * @param {{ draftSeq: number | null, rest: string } | undefined} o.staffDraftParsed
 * @param {import("@supabase/supabase-js").SupabaseClient} o.sb
 * @param {string} o.bodyText
 * @param {string} o.canonicalBrainActorKey
 * @param {() => object} o.staffMeta — early returns before draft seq known
 * @returns {Promise<
 *   | { ok: false; result: object }
 *   | { ok: true; bodyText: string; sessionAtStart: object; draftSeqActive: number | null; staffTypedPayload: string }
 * >}
 */
async function resolveStaffCaptureBodyAndSession(o) {
  const {
    isStaffCapture,
    explicitCanonical,
    draftOwnerKey,
    transportActorKey,
    mode,
    traceStartMs,
    traceId,
    staffRow,
    staffDraftParsed,
    sb,
    bodyText: bodyTextIn,
    canonicalBrainActorKey,
    staffMeta,
  } = o;

  if (!isStaffCapture) {
    const sessionAtStart = await getIntakeSession(canonicalBrainActorKey);
    return {
      ok: true,
      bodyText: bodyTextIn,
      sessionAtStart,
      draftSeqActive: null,
      staffTypedPayload: "",
    };
  }

  if (draftOwnerKey !== explicitCanonical) {
    emitTimed(traceStartMs, {
      level: "error",
      trace_id: traceId,
      log_kind: "brain",
      event: "STAFF_CAPTURE_CANONICAL_INVARIANT_VIOLATION",
      data: {
        crumb: "staff_capture_canonical_invariant",
        draftOwnerKey,
        explicitCanonical,
        transportActorKey,
        mode,
      },
    });
    return {
      ok: false,
      result: {
        ok: false,
        brain: "core_invariant_canonical_mismatch",
        replyText: "Internal error: staff capture canonical identity mismatch.",
        ...staffMeta(),
        ...outgateMeta("MAINTENANCE_ERROR_NO_ACTOR"),
      },
    };
  }
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: "STAFF_CAPTURE_CANONICAL_OK",
    data: {
      crumb: "staff_capture_canonical_ok",
      draft_owner_key: draftOwnerKey,
      transport_actor_key: transportActorKey,
      staff_id: staffRow && staffRow.staff_id ? String(staffRow.staff_id) : "",
    },
  });

  const parsed =
    staffDraftParsed && typeof staffDraftParsed === "object"
      ? staffDraftParsed
      : parseStaffCapDraftIdFromStripped("");
  const staffTypedPayload = String(parsed.rest || "").trim();
  const resolved = await resolveStaffCaptureDraftTurn(
    sb,
    draftOwnerKey,
    parsed,
    bodyTextIn
  );
  if (!resolved.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        brain: "staff_capture_draft_resolve_failed",
        replyText: resolved.error,
        ...staffMeta(),
        ...outgateMeta("MAINTENANCE_ERROR_STAFF_DRAFT"),
      },
    };
  }

  return {
    ok: true,
    bodyText: resolved.effectiveBody,
    sessionAtStart: resolved.session,
    draftSeqActive: resolved.draftSeq,
    staffTypedPayload,
  };
}

module.exports = { resolveStaffCaptureBodyAndSession };
