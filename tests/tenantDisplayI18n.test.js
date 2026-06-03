const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const origEnabled = process.env.PROPERA_TENANT_I18N_ENABLED;
const origKey = process.env.OPENAI_API_KEY;

describe("tenantDisplayI18n", () => {
  before(() => {
    process.env.PROPERA_TENANT_I18N_ENABLED = "1";
    process.env.OPENAI_API_KEY = "test-key";
  });

  after(() => {
    if (origEnabled === undefined) delete process.env.PROPERA_TENANT_I18N_ENABLED;
    else process.env.PROPERA_TENANT_I18N_ENABLED = origEnabled;
    if (origKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origKey;
  });

  test("applyDisplayToTenantTicket adds descriptionDisplay for English body when UI es", async () => {
    const translate = require("../src/tenant/translateTenantText");
    translate._clearTranslationCacheForTest();
    translate._setChatCompletionsFnForTest(async () => ({
      ok: true,
      status: 200,
      data: {
        choices: [{ message: { content: "Fuga de agua en la cocina" } }],
      },
    }));

    const { applyDisplayToTenantTicket } = require("../src/tenant/tenantDisplayI18n");
    const out = await applyDisplayToTenantTicket(
      {
        title: "Water leak in kitchen",
        description: "Water leak in the kitchen since yesterday",
        serviceNotes: "",
        timeline: [{ action: "Ticket created", by: "System", time: "2026-01-01T00:00:00Z", color: "#000" }],
      },
      "es"
    );

    assert.equal(out.descriptionDisplay, "Fuga de agua en la cocina");
    assert.equal(out.description, "Water leak in the kitchen since yesterday");

    translate._setChatCompletionsFnForTest(null);
    translate._clearTranslationCacheForTest();
  });

  test("skips display fields when UI is en", async () => {
    const { applyDisplayToTenantTicket } = require("../src/tenant/tenantDisplayI18n");
    const out = await applyDisplayToTenantTicket(
      { title: "Water leak", description: "Kitchen sink", serviceNotes: "" },
      "en"
    );
    assert.equal(out.descriptionDisplay, undefined);
  });
});
