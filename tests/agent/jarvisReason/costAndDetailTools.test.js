"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.PROPERA_FINANCE_ENABLED = "1";
process.env.JARVIS_REASON_MAX_STEPS = "2";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../../../src/db/supabase");
const {
  lookupCosts,
  getTicketDetail,
  runJarvisReasoning,
  setReasonChatForTests,
  clearReasonChatForTests,
} = require("../../../src/agent/jarvisReason");

// Chainable Supabase stub: records eq/gte/lte, applies on await.
function makeSb(rows) {
  return {
    from() {
      const eqs = [];
      const gtes = [];
      const ltes = [];
      const builder = {
        select: () => builder,
        eq: (c, v) => (eqs.push([c, v]), builder),
        gte: (c, v) => (gtes.push([c, v]), builder),
        lte: (c, v) => (ltes.push([c, v]), builder),
        order: () => builder,
        limit: () => builder,
        then(resolve) {
          let out = rows.slice();
          for (const [c, v] of eqs) out = out.filter((r) => String(r[c]) === String(v));
          for (const [c, v] of gtes) out = out.filter((r) => String(r[c] || "") >= String(v));
          for (const [c, v] of ltes) out = out.filter((r) => String(r[c] || "") <= String(v));
          resolve({ data: out, error: null });
        },
      };
      return builder;
    },
  };
}

function seedCosts() {
  return [
    { amount_cents: 5000, tenant_charge_amount_cents: 0, entry_type: "parts", property_code: "PENN", vendor_name: "Home Depot", description: "p-trap", created_at: "2026-06-01T00:00:00Z", ticket_id: "t1", program_run_id: null, voided_at: null },
    { amount_cents: 12000, tenant_charge_amount_cents: 8000, entry_type: "labor", property_code: "PENN", vendor_name: "", description: "2h labor", created_at: "2026-05-15T00:00:00Z", ticket_id: "t2", program_run_id: null, voided_at: null },
    { amount_cents: 30000, tenant_charge_amount_cents: 0, entry_type: "vendor_invoice", property_code: "MORRIS", vendor_name: "Acme Plumbing", description: "main line", created_at: "2026-03-01T00:00:00Z", ticket_id: "t3", program_run_id: null, voided_at: null },
    { amount_cents: 9999, tenant_charge_amount_cents: 0, entry_type: "parts", property_code: "PENN", vendor_name: "Lowes", description: "voided", created_at: "2026-06-02T00:00:00Z", ticket_id: "t4", program_run_id: null, voided_at: "2026-06-03T00:00:00Z" },
  ];
}

describe("lookupCosts", () => {
  afterEach(() => clearSupabaseClientForTests());

  test("totals company + tenant charge across portfolio (voided excluded)", async () => {
    setSupabaseClientForTests(makeSb(seedCosts()));
    const res = await lookupCosts({});
    assert.equal(res.ok, true);
    assert.equal(res.entryCount, 3); // voided row dropped
    assert.equal(res.totalCompanyCents, 47000);
    assert.equal(res.totalTenantChargeCents, 8000);
    assert.equal(res.totalCompany, "$470.00");
  });

  test("property scope + voided exclusion", async () => {
    setSupabaseClientForTests(makeSb(seedCosts()));
    const res = await lookupCosts({ propertyCode: "penn" });
    assert.equal(res.entryCount, 2); // PENN parts + labor (voided PENN parts excluded)
    assert.equal(res.totalCompanyCents, 17000);
  });

  test("entryTypeIn filters cost types", async () => {
    setSupabaseClientForTests(makeSb(seedCosts()));
    const res = await lookupCosts({ entryTypeIn: ["parts"] });
    assert.equal(res.entryCount, 1); // only the non-voided parts row
    assert.equal(res.totalCompanyCents, 5000);
  });

  test("groupBy entry_type returns a spend breakdown", async () => {
    setSupabaseClientForTests(makeSb(seedCosts()));
    const res = await lookupCosts({ groupBy: "entry_type", countOnly: true });
    assert.equal(res.rows.length, 0);
    assert.equal(res.breakdown.parts.companyCents, 5000);
    assert.equal(res.breakdown.labor.companyCents, 12000);
    assert.equal(res.breakdown.vendor_invoice.companyCents, 30000);
  });

  test("finance disabled => finance_not_enabled (not $0)", async () => {
    const saved = process.env.PROPERA_FINANCE_ENABLED;
    delete process.env.PROPERA_FINANCE_ENABLED;
    try {
      const res = await lookupCosts({});
      assert.equal(res.ok, false);
      assert.equal(res.error, "finance_not_enabled");
    } finally {
      process.env.PROPERA_FINANCE_ENABLED = saved;
    }
  });
});

describe("getTicketDetail", () => {
  test("requires a ticket reference", async () => {
    const res = await getTicketDetail({});
    assert.equal(res.ok, false);
    assert.equal(res.error, "missing_ticket_ref");
  });
});

describe("reasoning loop — new tool registration", () => {
  afterEach(() => {
    clearReasonChatForTests();
    clearSupabaseClientForTests();
  });

  test("model can drive lookup_costs through the loop", async () => {
    setSupabaseClientForTests(makeSb(seedCosts()));
    let turn = 0;
    setReasonChatForTests((body) => {
      turn += 1;
      if (turn === 1) {
        return {
          ok: true,
          data: {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: {
                        name: "lookup_costs",
                        arguments: JSON.stringify({ createdAfter: "2026-01-01" }),
                      },
                    },
                  ],
                },
              },
            ],
          },
        };
      }
      return { ok: true, data: { choices: [{ message: { content: "You spent $470.00 this year." } }] } };
    });

    const res = await runJarvisReasoning({ question: "how much did we spend this year?" });
    assert.equal(res.ok, true);
    assert.equal(res.reply, "You spent $470.00 this year.");
    assert.equal(res.trace[0].tool, "lookup_costs");
    assert.equal(res.trace[0].ok, true);
  });
});
