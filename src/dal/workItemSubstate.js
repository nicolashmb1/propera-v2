const { getSupabase } = require("../db/supabase");

/**
 * @param {string} workItemId
 * @param {string} substate
 */
async function setWorkItemSubstate(workItemId, substate) {
  const sb = getSupabase();
  if (!sb) return { ok: false };
  const id = String(workItemId || "").trim();
  if (!id) return { ok: false };

  const now = new Date().toISOString();
  const { error } = await sb
    .from("work_items")
    .update({ substate: String(substate != null ? substate : ""), updated_at: now })
    .eq("work_item_id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = { setWorkItemSubstate };
