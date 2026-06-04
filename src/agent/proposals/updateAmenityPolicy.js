/**
 * update_amenity_policy — Jarvis Plan → Access Engine upsertAccessPolicyForLocation.
 * Merges with current policy so partial updates (e.g. max block only) stay safe.
 */

const crypto = require("crypto");
const {
  getAccessPolicyForLocation,
  upsertAccessPolicyForLocation,
} = require("../../dal/accessEngine");
const { appendEventLog } = require("../../dal/appendEventLog");
const { PROPOSAL_OPS } = require("./types");
const { buildProposalConfirmToken } = require("./proposalToken");

/**
 * @param {object|null} policy — mapPolicyRow shape
 */
function policyToUpsertBody(policy) {
  if (!policy) return {};
  return {
    minDurationMin: policy.minDurationMin,
    maxDurationMin: policy.maxDurationMin,
    advanceBookingMin: policy.advanceBookingMin,
    advanceBookingMaxDays: policy.advanceBookingMaxDays,
    sameDayAllowed: policy.sameDayAllowed,
    maxConcurrent: policy.maxConcurrent,
    maxPerTenantDay: policy.maxPerTenantDay,
    maxPerTenantWeek: policy.maxPerTenantWeek,
    maxPerTenantMonth: policy.maxPerTenantMonth,
    requiresApproval: policy.requiresApproval,
    approvalTimeoutMin: policy.approvalTimeoutMin,
    approvalTimeoutAction: policy.approvalTimeoutAction,
    depositAmount: policy.depositAmount,
    depositRefundable: policy.depositRefundable,
    depositRefundCutoffHours: policy.depositRefundCutoffHours,
    hourlyRate: policy.hourlyRate,
    eligibleTenants: policy.eligibleTenants,
    guestAllowed: policy.guestAllowed,
    maxGuests: policy.maxGuests,
    reminderBeforeMin: policy.reminderBeforeMin,
    staffNotifyOnReserve: policy.staffNotifyOnReserve,
    staffNotifyOnCancel: policy.staffNotifyOnCancel,
    staffNotifyReminderCopy: policy.staffNotifyReminderCopy,
  };
}

function pickPolicyPatch(args) {
  const patch = {};
  const maxBlock = args.max_duration_min ?? args.maxDurationMin ?? args.max_block_min ?? args.maxBlockMin;
  const minBlock = args.min_duration_min ?? args.minDurationMin ?? args.min_block_min ?? args.minBlockMin;
  const advanceMin = args.advance_booking_min ?? args.advanceBookingMin;
  const advanceMaxDays = args.advance_booking_max_days ?? args.advanceBookingMaxDays;
  const maxPerDay = args.max_per_tenant_day ?? args.maxPerTenantDay;
  const requiresApproval = args.requires_approval ?? args.requiresApproval;

  if (maxBlock != null && maxBlock !== "") patch.maxDurationMin = Number(maxBlock);
  if (minBlock != null && minBlock !== "") patch.minDurationMin = Number(minBlock);
  if (advanceMin != null && advanceMin !== "") patch.advanceBookingMin = Number(advanceMin);
  if (advanceMaxDays != null && advanceMaxDays !== "") {
    patch.advanceBookingMaxDays = Number(advanceMaxDays);
  }
  if (maxPerDay != null && maxPerDay !== "") patch.maxPerTenantDay = Number(maxPerDay);
  if (requiresApproval != null && requiresApproval !== "") {
    patch.requiresApproval = requiresApproval === true || requiresApproval === "true";
  }

  return patch;
}

function formatPolicyChangeSummary(before, after) {
  const bits = [];
  if (before?.maxDurationMin !== after?.maxDurationMin && after?.maxDurationMin != null) {
    bits.push(`max block ${after.maxDurationMin} min`);
  }
  if (before?.minDurationMin !== after?.minDurationMin && after?.minDurationMin != null) {
    bits.push(`min block ${after.minDurationMin} min`);
  }
  if (before?.advanceBookingMin !== after?.advanceBookingMin && after?.advanceBookingMin != null) {
    bits.push(`advance notice ${after.advanceBookingMin} min`);
  }
  if (
    before?.maxPerTenantDay !== after?.maxPerTenantDay &&
    after?.maxPerTenantDay != null
  ) {
    bits.push(`${after.maxPerTenantDay} bookings/day`);
  }
  if (
    before?.requiresApproval !== after?.requiresApproval &&
    after?.requiresApproval != null
  ) {
    bits.push(after.requiresApproval ? "approval required" : "auto-confirm");
  }
  return bits.length ? bits.join(", ") : "policy updated";
}

/**
 * @param {object} draft
 * @param {string} summary
 */
function proposalFromUpdateAmenityPolicyDraft(draft, summary) {
  const d = draft || {};
  return {
    version: "1",
    proposal_id: String(d.proposal_id || crypto.randomUUID()).trim(),
    op: PROPOSAL_OPS.UPDATE_AMENITY_POLICY,
    state: "awaiting_confirm",
    summary_human: String(summary || "").trim(),
    target: {
      location_id: String(d.locationId || d.location_id || "").trim(),
      location_name: String(d.locationName || d.location_name || "").trim(),
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
    },
    payload: {
      location_id: String(d.locationId || d.location_id || "").trim(),
      location_name: String(d.locationName || d.location_name || "").trim(),
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
      policy_patch: d.policyPatch || d.policy_patch || {},
      policy_summary: String(d.policySummary || d.policy_summary || "").trim(),
      max_duration_min: d.policyPatch?.maxDurationMin ?? d.policy_patch?.maxDurationMin,
      min_duration_min: d.policyPatch?.minDurationMin ?? d.policy_patch?.minDurationMin,
    },
    approval_tier_suggested: 2,
    confirm_token: "",
  };
}

/**
 * @param {object} draft
 * @param {string} summary
 */
function buildUpdateAmenityPolicyProposal(draft, summary) {
  const proposalId = crypto.randomUUID();
  const policyPatch = draft.policyPatch || draft.policy_patch || {};
  const body = {
    ...draft,
    proposal_id: proposalId,
    location_id: String(draft.locationId || draft.location_id || "").trim(),
    location_name: String(draft.locationName || draft.location_name || "").trim(),
    property_code: String(draft.propertyCode || draft.property_code || "")
      .trim()
      .toUpperCase(),
    policy_patch: policyPatch,
    policy_summary: String(draft.policySummary || draft.policy_summary || "").trim(),
  };
  const token = buildProposalConfirmToken(body, PROPOSAL_OPS.UPDATE_AMENITY_POLICY);
  const proposal = proposalFromUpdateAmenityPolicyDraft(body, summary);
  proposal.confirm_token = token;
  return { proposal, confirmToken: token };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} _sb
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {{ traceId?: string, actorLabel?: string }} ctx
 */
async function commitUpdateAmenityPolicy(_sb, verified, ctx) {
  const p = verified.payload || {};
  const locationId = String(p.location_id || p.locationId || "").trim();
  const locationName = String(p.location_name || p.locationName || "").trim();
  const patch = p.policy_patch || p.policyPatch || {};

  if (!locationId || !patch || typeof patch !== "object") {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Missing policy details — try proposing again.",
    };
  }

  const actorLabel = String(ctx.actorLabel || "Staff").trim() || "Staff";

  try {
    const current = await getAccessPolicyForLocation(locationId);
    const merged = { ...policyToUpsertBody(current), ...patch };
    const updated = await upsertAccessPolicyForLocation(locationId, merged, actorLabel);
    const summary = formatPolicyChangeSummary(current, updated);

    await appendEventLog({
      traceId: String(ctx.traceId || "").trim(),
      log_kind: "brain",
      event: "JARVIS_UPDATE_AMENITY_POLICY",
      payload: {
        proposal_id: verified.proposal_id,
        location_id: locationId,
        patch,
      },
    });

    const place = locationName || "amenity";
    return {
      ok: true,
      brain: "jarvis_plan",
      replyText: `Updated ${place} booking rules: ${summary}.`,
      resolution: {
        committed_op: PROPOSAL_OPS.UPDATE_AMENITY_POLICY,
        proposal_id: verified.proposal_id,
        location_name: locationName,
        policy_summary: summary,
        max_duration_min: updated?.maxDurationMin,
      },
    };
  } catch (err) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: `Policy not saved: ${String(err?.message || err || "failed")}`,
    };
  }
}

module.exports = {
  policyToUpsertBody,
  pickPolicyPatch,
  formatPolicyChangeSummary,
  proposalFromUpdateAmenityPolicyDraft,
  buildUpdateAmenityPolicyProposal,
  commitUpdateAmenityPolicy,
};
