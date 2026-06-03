const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const origEnabled = process.env.PROPERA_TENANT_I18N_ENABLED;
const origKey = process.env.OPENAI_API_KEY;

describe("tenantMaintenanceI18n", () => {
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

  test("Spanish description is translated to English before pipeline payload", async () => {
    const translate = require("../src/tenant/translateTenantText");
    translate._clearTranslationCacheForTest();
    translate._setChatCompletionsFnForTest(async () => ({
      ok: true,
      status: 200,
      data: {
        choices: [
          {
            message: {
              content: "Water leak in the kitchen since yesterday",
            },
          },
        ],
      },
    }));

    const { prepareMaintenanceTextForBrain } = require("../src/tenant/tenantMaintenanceI18n");
    const out = await prepareMaintenanceTextForBrain({
      description: "Hay una fuga de agua en la cocina desde ayer",
      locationDetail: "",
      preferredLanguage: "es",
      traceId: "test-trace",
    });

    assert.equal(out.description, "Water leak in the kitchen since yesterday");
    assert.equal(out.meta.translated, true);
    assert.equal(out.meta.uiLocale, "es");

    translate._setChatCompletionsFnForTest(null);
    translate._clearTranslationCacheForTest();
  });

  test("English description passes through without translate call", async () => {
    let called = false;
    const translate = require("../src/tenant/translateTenantText");
    translate._setChatCompletionsFnForTest(async () => {
      called = true;
      return { ok: true, status: 200, data: { choices: [{ message: { content: "x" } }] } };
    });

    const { prepareMaintenanceTextForBrain } = require("../src/tenant/tenantMaintenanceI18n");
    const text = "Water leak in the kitchen since yesterday";
    const out = await prepareMaintenanceTextForBrain({
      description: text,
      preferredLanguage: "en",
    });

    assert.equal(out.description, text);
    assert.equal(out.meta.translated, false);
    assert.equal(called, false);

    translate._setChatCompletionsFnForTest(null);
  });
});
