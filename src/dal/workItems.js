/**
 * Work item reads/writes — GAS WorkItems sheet parity (minimal columns).
 */
const { getSupabase } = require("../db/supabase");
const {
  cancelPendingLifecycleTimersForWorkItem,
} = require("./lifecycleTimers");

/**
 * Open items owned by this staff id (owner_id stores sheet-style STAFF_* id).
 */
async function listOpenWorkItemsForOwner(staffOwnerId) {
  const id = String(staffOwnerId || "").trim();
  if (!id) return [];
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("work_items")
    .select(
      "work_item_id, unit_id, property_id, ticket_key, status, state, metadata_json"
    )
    .eq("owner_id", id);

  if (error || !data) return [];

  return data.filter((row) => {
    const s = String(row.status || "").toUpperCase();
    return s !== "COMPLETED" && s !== "CANCELED" && s !== "DELETED";
  });
}

/**
 * @param {string} workItemId
 */
async function getWorkItemByWorkItemId(workItemId) {
  const wid = String(workItemId || "").trim();
  if (!wid) return null;
  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from("work_items")
    .select(
      "work_item_id, unit_id, property_id, ticket_key, owner_id, phone_e164, status, state, substate, metadata_json"
    )
    .eq("work_item_id", wid)
    .maybeSingle();

  if (error) return null;
  return data || null;
}

function mergeMetadata(existing, patch) {
  const base =
    existing && typeof existing === "object"
      ? existing
      : {};
  return { ...base, ...patch };
}

/**
 * Apply staff-reported outcome to work_items (deterministic mapping; full lifecycle engine later).
 */
async function applyStaffOutcomeUpdate(workItemId, normalizedOutcome, rawBodySnippet) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const wi = await getWorkItemByWorkItemId(workItemId);
  if (!wi) return { ok: false, error: "wi_not_found" };

  const snippet = String(rawBodySnippet || "").slice(0, 500);
  const existingMeta =
    wi.metadata_json && typeof wi.metadata_json === "object"
      ? wi.metadata_json
      : {};
  const meta = mergeMetadata(existingMeta, {
    staff_last_outcome_at: new Date().toISOString(),
    staff_last_raw: snippet,
  });

  let status = wi.status || "OPEN";
  let state = wi.state || "INTAKE";
  let substate = wi.substate || "";

  if (normalizedOutcome === "COMPLETED") {
    status = "COMPLETED";
    state = "DONE";
  } else if (normalizedOutcome === "IN_PROGRESS") {
    state = "IN_PROGRESS";
  } else if (typeof normalizedOutcome === "string") {
    substate = normalizedOutcome;
    meta.staff_outcome = normalizedOutcome;
  } else if (
    normalizedOutcome &&
    typeof normalizedOutcome === "object" &&
    normalizedOutcome.outcome === "WAITING_PARTS"
  ) {
    substate = "WAITING_PARTS";
    meta.parts_eta_text = normalizedOutcome.partsEtaText || "";
    if (normalizedOutcome.partsEtaAt)
      meta.parts_eta_at = normalizedOutcome.partsEtaAt.toISOString
        ? normalizedOutcome.partsEtaAt.toISOString()
        : String(normalizedOutcome.partsEtaAt);
  }

  const { error } = await sb
    .from("work_items")
    .update({
      status,
      state,
      substate,
      metadata_json: meta,
      updated_at: new Date().toISOString(),
    })
    .eq("work_item_id", workItemId);

  if (error) return { ok: false, error: error.message };

  const stUp = String(status || "").toUpperCase();
  const stateUp = String(state || "").trim().toUpperCase();
  if (stUp === "COMPLETED" || stateUp === "DONE") {
    await cancelPendingLifecycleTimersForWorkItem(
      sb,
      workItemId,
      "work_item_completed"
    );
  }

  return { ok: true, status, state, substate };
}

module.exports = {
  listOpenWorkItemsForOwner,
  getWorkItemByWorkItemId,
  applyStaffOutcomeUpdate,
};
