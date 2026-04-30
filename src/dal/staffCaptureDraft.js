/**
 * GAS staff #capture draft rows — `SCAP:D###` parity (see 20_CORE_ORCHESTRATOR.gs).
 * Each new `#…` line without `#d###` allocates a new monotonic `draft_seq`; `#d26 …` continues draft 26.
 *
 * Draft rows are keyed by **channel-agnostic owner id**: `canonicalBrainActorKey` from the signal layer
 * (`resolveCanonicalBrainActorKey`) — never raw transport `From` / `TG:` in core.
 */

/**
 * @param {string} s — text after stripping leading `#` (no media)
 * @returns {{ draftSeq: number | null, rest: string }}
 */
function parseStaffCapDraftIdFromStripped(s) {
  const t = String(s || "").trim();
  const match = t.match(/^#?d(\d+)\s*[:\-]?\s*(.*)$/i);
  if (match) {
    const n = parseInt(match[1], 10);
    if (!isFinite(n) || n < 1) return { draftSeq: null, rest: t };
    return { draftSeq: n, rest: String(match[2] || "").trim() };
  }
  return { draftSeq: null, rest: t };
}

/**
 * @param {number | null | undefined} draftSeq
 * @param {string} text
 * @returns {string}
 */
function tagStaffCaptureReply(draftSeq, text) {
  const t = String(text || "");
  if (draftSeq == null || !isFinite(Number(draftSeq))) return t;
  if (!t.trim()) return t;
  return `D${Number(draftSeq)}: ${t}`;
}

function rowToSessionShape(row) {
  if (!row) return null;
  return {
    phone_e164: row.staff_phone_e164,
    stage: row.stage,
    expected: row.expected,
    draft_property: row.draft_property,
    draft_unit: row.draft_unit,
    draft_issue: row.draft_issue,
    issue_buf_json: row.issue_buf_json,
    draft_schedule_raw: row.draft_schedule_raw,
    active_artifact_key: row.active_artifact_key,
    expires_at_iso: row.expires_at_iso,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} draftOwnerKey — `canonicalBrainActorKey` from normalized inbound / pipeline
 * @param {number} draftSeq
 */
async function getDraftByStaffAndSeq(sb, draftOwnerKey, draftSeq) {
  const phone = String(draftOwnerKey || "").trim();
  const seq = Number(draftSeq);
  if (!phone || !isFinite(seq)) return null;
  const { data, error } = await sb
    .from("staff_capture_drafts")
    .select("*")
    .eq("staff_phone_e164", phone)
    .eq("draft_seq", seq)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} draftOwnerKey
 */
async function allocateNewDraft(sb, draftOwnerKey) {
  const phone = String(draftOwnerKey || "").trim();
  if (!phone) return { ok: false, error: "no_phone" };

  const { data: seq, error: e1 } = await sb.rpc("next_staff_capture_draft_seq");
  if (e1 || seq == null) {
    return { ok: false, error: e1 ? e1.message : "no_seq" };
  }
  const draftSeq = Number(seq);
  const now = new Date().toISOString();
  const { error: e2 } = await sb.from("staff_capture_drafts").insert({
    draft_seq: draftSeq,
    staff_phone_e164: phone,
    stage: "",
    expected: "",
    draft_property: "",
    draft_unit: "",
    draft_issue: "",
    issue_buf_json: [],
    draft_schedule_raw: "",
    active_artifact_key: "",
    expires_at_iso: "",
    updated_at_iso: now,
    created_at: now,
  });
  if (e2) return { ok: false, error: e2.message };
  return { ok: true, draftSeq };
}

/**
 * Map intake_session-shaped partial to draft columns.
 * @param {object} partial — same keys as upsertIntakeSession
 */
function intakePartialToDraftPartial(partial) {
  const o = {};
  if (!partial || typeof partial !== "object") return o;
  if (partial.stage !== undefined) o.stage = partial.stage;
  if (partial.expected !== undefined) o.expected = partial.expected;
  if (partial.draft_property !== undefined) o.draft_property = partial.draft_property;
  if (partial.draft_unit !== undefined) o.draft_unit = partial.draft_unit;
  if (partial.draft_issue !== undefined) o.draft_issue = partial.draft_issue;
  if (partial.issue_buf_json !== undefined) o.issue_buf_json = partial.issue_buf_json;
  if (partial.draft_schedule_raw !== undefined)
    o.draft_schedule_raw = partial.draft_schedule_raw;
  if (partial.active_artifact_key !== undefined)
    o.active_artifact_key = partial.active_artifact_key;
  if (partial.expires_at_iso !== undefined) o.expires_at_iso = partial.expires_at_iso;
  return o;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} draftOwnerKey
 * @param {number} draftSeq
 * @param {object} partial — same shape as `upsertIntakeSession` row (stage, expected, draft_*, …)
 */
async function updateDraftFields(sb, draftOwnerKey, draftSeq, partial) {
  const phone = String(draftOwnerKey || "").trim();
  const seq = Number(draftSeq);
  if (!phone || !isFinite(seq)) return { ok: false };
  const mapped = intakePartialToDraftPartial(partial);
  const now = new Date().toISOString();
  const { error } = await sb
    .from("staff_capture_drafts")
    .update({ ...mapped, updated_at_iso: now })
    .eq("staff_phone_e164", phone)
    .eq("draft_seq", seq);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Clear draft row after finalize / abandon (GAS closes draft).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} draftOwnerKey
 * @param {number} draftSeq
 */
async function deleteDraft(sb, draftOwnerKey, draftSeq) {
  const phone = String(draftOwnerKey || "").trim();
  const seq = Number(draftSeq);
  if (!phone || !isFinite(seq)) return { ok: false };
  const { error } = await sb
    .from("staff_capture_drafts")
    .delete()
    .eq("staff_phone_e164", phone)
    .eq("draft_seq", seq);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} draftOwnerKey — canonical brain actor key (not raw transport id)
 * @param {{ draftSeq: number | null, rest: string }} parsed — from parseStaffCapDraftIdFromStripped(bodyBase)
 * @param {string} bodyTextComposed — merge text (media composed)
 */
async function resolveStaffCaptureDraftTurn(sb, draftOwnerKey, parsed, bodyTextComposed) {
  const phone = String(draftOwnerKey || "").trim();
  if (!phone) return { ok: false, error: "Missing draft owner key." };
  if (!sb) return { ok: false, error: "Database is not configured." };

  const effectiveBody = String(bodyTextComposed || "").trim();

  if (parsed && parsed.draftSeq != null) {
    const row = await getDraftByStaffAndSeq(sb, phone, parsed.draftSeq);
    if (!row) {
      return {
        ok: false,
        error: `Unknown draft D${parsed.draftSeq}. Start a new capture with #… or reply with a valid draft id (e.g. #d${parsed.draftSeq} …).`,
      };
    }
    return {
      ok: true,
      draftSeq: parsed.draftSeq,
      session: rowToSessionShape(row),
      effectiveBody,
    };
  }

  const alloc = await allocateNewDraft(sb, phone);
  if (!alloc.ok) {
    return {
      ok: false,
      error: "Could not start a new staff capture draft: " + (alloc.error || "error"),
    };
  }
  return {
    ok: true,
    draftSeq: alloc.draftSeq,
    session: rowToSessionShape(
      await getDraftByStaffAndSeq(sb, phone, alloc.draftSeq)
    ),
    effectiveBody,
  };
}

async function setScheduleWaitAfterFinalizeDraft(sb, draftOwnerKey, draftSeq, o) {
  return updateDraftFields(sb, draftOwnerKey, draftSeq, {
    stage: "SCHEDULE",
    expected: "SCHEDULE",
    draft_issue: o.draft_issue,
    issue_buf_json: Array.isArray(o.issue_buf_json) ? o.issue_buf_json : [],
    draft_property: o.draft_property,
    draft_unit: o.draft_unit,
    draft_schedule_raw: "",
    active_artifact_key: o.ticketKey,
    expires_at_iso: "",
  });
}

module.exports = {
  parseStaffCapDraftIdFromStripped,
  tagStaffCaptureReply,
  getDraftByStaffAndSeq,
  allocateNewDraft,
  updateDraftFields,
  deleteDraft,
  resolveStaffCaptureDraftTurn,
  intakePartialToDraftPartial,
  setScheduleWaitAfterFinalizeDraft,
  rowToSessionShape,
};
