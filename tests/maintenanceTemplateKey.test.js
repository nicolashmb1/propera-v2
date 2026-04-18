"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  maintenanceTemplateKeyForNext,
  MAINTENANCE_TEMPLATE,
} = require("../src/brain/core/buildMaintenancePrompt");

test("maintenanceTemplateKeyForNext maps slots", () => {
  assert.equal(
    maintenanceTemplateKeyForNext("ISSUE"),
    MAINTENANCE_TEMPLATE.ISSUE
  );
  assert.equal(
    maintenanceTemplateKeyForNext("SCHEDULE_PRETICKET"),
    MAINTENANCE_TEMPLATE.SCHEDULE_ASK
  );
  assert.equal(
    maintenanceTemplateKeyForNext("ATTACH_CLARIFY"),
    MAINTENANCE_TEMPLATE.ATTACH_CLARIFY
  );
  assert.equal(maintenanceTemplateKeyForNext(""), MAINTENANCE_TEMPLATE.FALLBACK);
});
