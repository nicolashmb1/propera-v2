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
