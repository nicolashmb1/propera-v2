/**
 * Contract for Ticket Timeline V1 — DB-trigger-owned event_kind values only.
 * Keep aligned with supabase/migrations/034_ticket_timeline_events.sql header.
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
