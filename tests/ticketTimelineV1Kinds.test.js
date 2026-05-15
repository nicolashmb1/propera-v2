/**
 * Contract for Ticket Timeline V1 — DB-trigger-owned event_kind values only.
 * Keep aligned with supabase/migrations/034_ticket_timeline_events.sql header
 * and 045_ticket_mutation_audit.sql (actor columns + trigger behavior).
 * Semantic kinds (message_received, timer_armed, …) are reserved for future V2 writers.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const DB_TRIGGER_TIMELINE_KINDS = Object.freeze([
  "created",
  "assigned",
  "scheduled",
  "vendor_eta",
  "status_changed",
  "resolved_closed",
]);

test("Ticket Timeline V1 DB-trigger kinds are unique and stable", () => {
  assert.equal(DB_TRIGGER_TIMELINE_KINDS.length, 6);
  assert.equal(new Set(DB_TRIGGER_TIMELINE_KINDS).size, 6);
});

/** V2 portal / finance writers — keep aligned with ticket_cost_entries DAL + portal_tickets_v1 color case. */
const V2_SEMANTIC_TIMELINE_KINDS = Object.freeze([
  "cost_added",
  "cost_updated",
  "tenant_charge_decision",
]);

test("V2 semantic finance timeline kinds are stable", () => {
  assert.equal(V2_SEMANTIC_TIMELINE_KINDS.length, 3);
  assert.equal(new Set(V2_SEMANTIC_TIMELINE_KINDS).size, 3);
});
