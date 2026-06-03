const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { rosterToTenantCtx, resolveTenantCtx } = require("../../src/voice/maxTools");

describe("resolveTenantCtx", () => {
  it("uses roster when phone matched", async () => {
    const ctx = {
      callerPhone: "+19083380390",
      rosterRow: {
        roster_id: "r1",
        phone_e164: "+19083380390",
        property_code: "PENN",
        unit_label: "502",
      },
    };
    const tenant = await resolveTenantCtx(ctx, {}, null);
    assert.equal(tenant.propertyCode, "PENN");
    assert.equal(tenant.unitLabel, "502");
    assert.equal(tenant.tenantId, "r1");
  });

  it("builds ctx from stated property and unit when no roster", async () => {
    const sb = {
      from() {
        return this;
      },
      select() {
        return Promise.resolve({
          data: [
            {
              code: "PENN",
              display_name: "The Grand at Penn",
              ticket_prefix: "PENN",
              short_name: "Grand",
              aliases: [],
            },
          ],
        });
      },
    };
    const ctx = { callerPhone: "+15551234567", rosterRow: null };
    const tenant = await resolveTenantCtx(
      ctx,
      { property: "The Grand at Penn", unit_label: "502" },
      sb
    );
    assert.equal(tenant.phone, "+15551234567");
    assert.equal(tenant.propertyCode, "PENN");
    assert.equal(tenant.unitLabel, "502");
    assert.equal(tenant.tenantId, "");
  });

  it("returns null without property or unit when no roster", async () => {
    const ctx = { callerPhone: "+15551234567", rosterRow: null };
    const tenant = await resolveTenantCtx(ctx, { unit_label: "502" }, null);
    assert.equal(tenant, null);
  });
});

describe("rosterToTenantCtx", () => {
  it("maps roster row", () => {
    const ctx = rosterToTenantCtx({
      roster_id: "r1",
      phone_e164: "+19083380390",
      property_code: "PENN",
      unit_label: "3B",
    });
    assert.equal(ctx.unitLabel, "3B");
  });
});
