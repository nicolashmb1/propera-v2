const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeTenantUiLocale,
  isSupportedTenantUiLocale,
} = require("../src/tenant/tenantI18nLocale");

describe("tenantI18nLocale", () => {
  test("normalizeTenantUiLocale defaults to en", () => {
    assert.equal(normalizeTenantUiLocale(""), "en");
    assert.equal(normalizeTenantUiLocale(undefined), "en");
    assert.equal(normalizeTenantUiLocale("pt"), "en");
  });

  test("normalizeTenantUiLocale accepts es", () => {
    assert.equal(normalizeTenantUiLocale("es"), "es");
    assert.equal(normalizeTenantUiLocale(" ES "), "es");
  });

  test("isSupportedTenantUiLocale", () => {
    assert.equal(isSupportedTenantUiLocale("en"), true);
    assert.equal(isSupportedTenantUiLocale("es"), true);
    assert.equal(isSupportedTenantUiLocale("pt"), false);
    assert.equal(isSupportedTenantUiLocale("fr"), false);
  });
});
