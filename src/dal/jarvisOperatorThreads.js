/**
 * Jarvis operator thread persistence (spine layer 2).
 * @see docs/JARVIS_SPINE.md § Thread state
 */

const { TTL_MS } = require("../brain/staff/expenseConfirmToken");

const THREAD_STATUSES = new Set([
  "idle",
  "gathering",
  "proposal_pending",
  "executing",
  "done",
]);

const PROPOSAL_STATES = new Set([
  "draft",
  "awaiting_confirm",
  "approved",
  "rejected",
  "committed",
  "failed",
  "expired",
]);

function nowIso() {
  return new Date().toISOString();
}

function defaultExpiresAt() {
  return new Date(Date.now() + TTL_MS).toISOString();
}

/**
 * @param {unknown} rows
 */
function parsePendingProposals(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r && typeof r === "object");
}

/**
 * Drop expired awaiting_confirm entries.
 * @param {object[]} pending
 */
function pruneExpiredPending(pending) {
  const now = Date.now();
  return pending.map((p) => {
    const exp = p.expires_at ? new Date(String(p.expires_at)).getTime() : 0;
    if (p.state === "awaiting_confirm" && exp && now > exp) {
      return { ...p, state: "expired" };
    }
    return p;
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} o
 */
async function loadJarvisThread(sb, o) {
  const threadId = String(o.threadId || "").trim();
  if (!threadId) return null;
  const { data, error } = await sb
    .from("jarvis_operator_threads")
    .select("*")
    .eq("thread_id", threadId)
    .maybeSingle();
  if (error || !data) return null;
  const pending = pruneExpiredPending(parsePendingProposals(data.pending_proposals));
  return {
    threadId: data.thread_id,
    actorKey: data.actor_key,
    transportChannel: data.transport_channel,
    anchorFingerprint: data.anchor_fingerprint,
    status: data.status,
    pendingProposals: pending,
    lastReceipt: data.last_receipt || null,
    scopeSnapshot: data.scope_snapshot || null,
    expiresAt: data.expires_at,
    updatedAt: data.updated_at,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} o
 */
async function upsertJarvisThread(sb, o) {
  const threadId = String(o.threadId || "").trim();
  const actorKey = String(o.actorKey || "").trim();
  const transportChannel = String(o.transportChannel || "portal").trim() || "portal";
  const anchorFingerprint = String(o.anchorFingerprint || "global").trim() || "global";
  if (!threadId || !actorKey) return null;

  const status = THREAD_STATUSES.has(String(o.status || ""))
    ? String(o.status)
    : "idle";
  const pending = parsePendingProposals(o.pendingProposals);
  const row = {
    thread_id: threadId,
    actor_key: actorKey,
    transport_channel: transportChannel,
    anchor_fingerprint: anchorFingerprint,
    status,
    pending_proposals: pending,
    last_receipt: o.lastReceipt != null ? o.lastReceipt : null,
    scope_snapshot: o.scopeSnapshot != null ? o.scopeSnapshot : null,
    expires_at: o.expiresAt || defaultExpiresAt(),
    updated_at: nowIso(),
  };

  const { data, error } = await sb
    .from("jarvis_operator_threads")
    .upsert(row, { onConflict: "thread_id" })
    .select("*")
    .maybeSingle();

  if (error || !data) return null;
  return loadJarvisThread(sb, { threadId: data.thread_id });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} actorKey
 * @param {string} transportChannel
 */
async function findLatestJarvisThreadForActor(sb, actorKey, transportChannel) {
  const actor = String(actorKey || "").trim();
  const channel = String(transportChannel || "portal").trim() || "portal";
  if (!actor) return null;
  const { data, error } = await sb
    .from("jarvis_operator_threads")
    .select("thread_id")
    .eq("actor_key", actor)
    .eq("transport_channel", channel)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return loadJarvisThread(sb, { threadId: data.thread_id });
}

/**
 * @param {object[]} pending
 */
function latestAwaitingProposal(pending) {
  const rows = pruneExpiredPending(parsePendingProposals(pending)).filter(
    (p) => p.state === "awaiting_confirm"
  );
  if (!rows.length) return null;
  rows.sort((a, b) => {
    const at = new Date(String(a.created_at || 0)).getTime() || 0;
    const bt = new Date(String(b.created_at || 0)).getTime() || 0;
    return bt - at;
  });
  return rows[0];
}

/**
 * Find newest awaiting proposal for actor/channel across threads.
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} actorKey
 * @param {string} transportChannel
 */
async function findAwaitingProposalForActor(sb, actorKey, transportChannel) {
  const actor = String(actorKey || "").trim();
  const channel = String(transportChannel || "portal").trim() || "portal";
  if (!actor) return null;

  const { data, error } = await sb
    .from("jarvis_operator_threads")
    .select("thread_id, pending_proposals, updated_at")
    .eq("actor_key", actor)
    .eq("transport_channel", channel)
    .order("updated_at", { ascending: false })
    .limit(10);
  if (error || !Array.isArray(data) || data.length === 0) return null;

  for (const row of data) {
    const awaiting = latestAwaitingProposal(row.pending_proposals);
    if (awaiting) {
      return {
        threadId: String(row.thread_id || "").trim(),
        proposal: awaiting,
      };
    }
  }
  return null;
}

/**
 * @param {object[]} pending
 * @param {object} entry
 */
function upsertPendingEntry(pending, entry) {
  const id = String(entry.proposal_id || "").trim();
  const list = [...pending];
  const idx = list.findIndex((p) => String(p.proposal_id || "") === id);
  if (idx >= 0) list[idx] = { ...list[idx], ...entry };
  else list.push(entry);
  return list;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} o
 */
async function addPendingProposalToThread(sb, o) {
  const threadId = String(o.threadId || "").trim();
  const proposal = o.proposal || {};
  const proposalId = String(proposal.proposal_id || proposal.proposalId || "").trim();
  if (!threadId || !proposalId) return null;

  const existing = await loadJarvisThread(sb, { threadId });
  if (!existing) return null;

  const entry = {
    proposal_id: proposalId,
    op: String(proposal.op || "").trim(),
    state: PROPOSAL_STATES.has(String(proposal.state || ""))
      ? String(proposal.state)
      : "awaiting_confirm",
    confirm_token: String(proposal.confirm_token || proposal.confirmToken || "").trim(),
    summary_human: String(proposal.summary_human || proposal.summaryHuman || "").trim(),
    depends_on: proposal.depends_on || proposal.dependsOn || null,
    created_at: proposal.created_at || nowIso(),
    expires_at: proposal.expires_at || defaultExpiresAt(),
  };

  const pending = upsertPendingEntry(
    pruneExpiredPending(existing.pendingProposals),
    entry
  );

  return upsertJarvisThread(sb, {
    threadId,
    actorKey: existing.actorKey,
    transportChannel: existing.transportChannel,
    anchorFingerprint: existing.anchorFingerprint,
    status: "proposal_pending",
    pendingProposals: pending,
    lastReceipt: existing.lastReceipt,
    scopeSnapshot: o.scopeSnapshot != null ? o.scopeSnapshot : existing.scopeSnapshot,
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} o
 */
async function markProposalOnThread(sb, o) {
  const threadId = String(o.threadId || "").trim();
  const proposalId = String(o.proposalId || "").trim();
  const newState = String(o.state || "").trim();
  if (!threadId || !proposalId || !PROPOSAL_STATES.has(newState)) return null;

  const existing = await loadJarvisThread(sb, { threadId });
  if (!existing) return null;

  const pending = existing.pendingProposals.map((p) =>
    String(p.proposal_id || "") === proposalId ? { ...p, state: newState } : p
  );

  const stillAwaiting = pending.some((p) => p.state === "awaiting_confirm");
  const status = stillAwaiting
    ? "proposal_pending"
    : newState === "committed"
      ? "done"
      : existing.status;

  return upsertJarvisThread(sb, {
    threadId,
    actorKey: existing.actorKey,
    transportChannel: existing.transportChannel,
    anchorFingerprint: existing.anchorFingerprint,
    status,
    pendingProposals: pending,
    lastReceipt: o.lastReceipt != null ? o.lastReceipt : existing.lastReceipt,
    scopeSnapshot: existing.scopeSnapshot,
  });
}

/**
 * @param {object} thread
 */
function threadSummaryForPortal(thread) {
  if (!thread) return null;
  return {
    thread_id: thread.threadId,
    status: thread.status,
    anchor_fingerprint: thread.anchorFingerprint,
    pending_proposals: (thread.pendingProposals || []).map((p) => ({
      proposal_id: p.proposal_id,
      op: p.op,
      state: p.state,
      summary_human: p.summary_human,
      depends_on: p.depends_on || null,
      expires_at: p.expires_at,
    })),
    last_receipt: thread.lastReceipt || null,
  };
}

module.exports = {
  loadJarvisThread,
  upsertJarvisThread,
  findLatestJarvisThreadForActor,
  findAwaitingProposalForActor,
  addPendingProposalToThread,
  markProposalOnThread,
  threadSummaryForPortal,
  pruneExpiredPending,
};
