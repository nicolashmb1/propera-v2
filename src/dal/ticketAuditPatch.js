/**
 * Server-written ticket audit columns (`changed_by_actor_*`) for timeline + accountability.
 * @see supabase/migrations/045_ticket_mutation_audit.sql
 */

/**
 * @param {string} label
 * @param {string} [source]
 * @returns {Record<string, string>}
 */
function systemTicketActor(label, source = "policy") {
  const l = String(label || "").trim() || "System";
  return {
    changed_by_actor_type: "SYSTEM",
    changed_by_actor_id: "",
    changed_by_actor_label: l.slice(0, 200),
    changed_by_actor_source: String(source || "policy").trim().slice(0, 80) || "policy",
  };
}

/** @returns {Record<string, string>} */
function lifecycleTimerActor() {
  return systemTicketActor("Lifecycle Timer", "lifecycle");
}

/** @returns {Record<string, string>} */
function tenantSmsActor() {
  return systemTicketActor("Tenant SMS", "sms");
}

/** @returns {Record<string, string>} */
function telegramStaffCaptureActor() {
  return systemTicketActor("Telegram Staff Capture", "telegram");
}

/**
 * @param {object} o
 * @param {string} o.staffId — `staff.staff_id` text
 * @param {string} o.displayName
 * @param {string} [o.source]
 * @returns {Record<string, string>}
 */
function staffTicketActor(o) {
  const sid = String(o.staffId || "").trim();
  const label = String(o.displayName || "").trim() || sid;
  const src = String(o.source || "propera_app").trim().slice(0, 80) || "propera_app";
  return {
    changed_by_actor_type: "STAFF",
    changed_by_actor_id: sid.slice(0, 120),
    changed_by_actor_label: label.slice(0, 200),
    changed_by_actor_source: src,
  };
}

/**
 * @param {Record<string, unknown>} patch
 * @param {Record<string, string>} audit — from staffTicketActor / systemTicketActor
 * @returns {Record<string, unknown>}
 */
function mergeChangedByIntoTicketPatch(patch, audit) {
  const p = patch && typeof patch === "object" ? { ...patch } : {};
  const a = audit || {};
  if (a.changed_by_actor_type != null) p.changed_by_actor_type = String(a.changed_by_actor_type).slice(0, 40);
  if (a.changed_by_actor_id != null) p.changed_by_actor_id = String(a.changed_by_actor_id).slice(0, 120);
  if (a.changed_by_actor_label != null) p.changed_by_actor_label = String(a.changed_by_actor_label).slice(0, 200);
  if (a.changed_by_actor_source != null) p.changed_by_actor_source = String(a.changed_by_actor_source).slice(0, 80);
  return p;
}

module.exports = {
  systemTicketActor,
  lifecycleTimerActor,
  tenantSmsActor,
  telegramStaffCaptureActor,
  staffTicketActor,
  mergeChangedByIntoTicketPatch,
};
