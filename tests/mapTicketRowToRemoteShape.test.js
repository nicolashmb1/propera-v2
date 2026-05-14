const test = require("node:test");
const assert = require("node:assert/strict");
const { mapTicketRowToRemoteShape } = require("../src/portal/mapTicketRowToRemoteShape");

test("maps tenant_name into remote tenant.name", () => {
  const row = {
    ticket_id: "PENN-042626-7797",
    property_display_name: "The Grand at Penn",
    unit_label: "414",
    status: "Open",
    priority: "normal",
    message_raw: "door replacement",
    tenant_phone_e164: "+19085550000",
    tenant_name: "Maria Lopez",
  };
  const out = mapTicketRowToRemoteShape(row);
  assert.equal(out.tenant.name, "Maria Lopez");
  assert.equal(out.tenant.phone, "+19085550000");
});

test("passes ticket_row_id when present (finance APIs)", () => {
  const row = {
    ticket_id: "PENN-1",
    ticket_row_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    property_code: "PENN",
    unit_label: "101",
    status: "Open",
    priority: "normal",
    message_raw: "test",
    tenant_phone_e164: "",
    is_imported_history: false,
  };
  const out = mapTicketRowToRemoteShape(row);
  assert.equal(out.ticketRowId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});
