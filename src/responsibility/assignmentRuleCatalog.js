/**
 * Phase 3 — auto-assignment rule catalog (platform modules + default rule templates).
 * @see docs/RESPONSIBILITY_ROUTING_REFACTOR.md §3.2
 */

const { isValidRoleKey } = require("./roleCatalog");

/** @type {Array<{ module: string, label: string, description: string }>} */
const ASSIGNMENT_MODULES = [
  {
    module: "maintenance",
    label: "Maintenance",
    description: "Tenant and staff maintenance tickets at create.",
  },
  {
    module: "office",
    label: "Office",
    description: "Office inquiries when the office intake module is enabled.",
  },
  {
    module: "leasing",
    label: "Leasing",
    description: "Leasing inquiries when the leasing module is enabled.",
  },
];

/** Default rules seeded per org (migration 081). */
const DEFAULT_ORG_ASSIGNMENT_RULES = [
  {
    ruleKey: "maintenance:building_super",
    label: "Building lead (primary)",
    module: "maintenance",
    propertyCode: "*",
    priority: 10,
    targetKind: "primary_role",
    targetRef: "building_super",
    assignMode: "staff",
    enabled: true,
  },
  {
    ruleKey: "maintenance:maintenance_tech_fallback",
    label: "Maintenance staff (fallback)",
    module: "maintenance",
    propertyCode: "*",
    priority: 20,
    targetKind: "primary_role",
    targetRef: "maintenance_tech",
    assignMode: "staff",
    enabled: true,
  },
  {
    ruleKey: "office:office_staff",
    label: "Office staff",
    module: "office",
    propertyCode: "*",
    priority: 10,
    targetKind: "primary_role",
    targetRef: "office_staff",
    assignMode: "staff",
    enabled: false,
  },
  {
    ruleKey: "leasing:leasing",
    label: "Leasing contact",
    module: "leasing",
    propertyCode: "*",
    priority: 10,
    targetKind: "primary_role",
    targetRef: "leasing",
    assignMode: "staff",
    enabled: false,
  },
];

const VALID_TARGET_KINDS = new Set(["primary_role", "staff_id", "vendor_policy_key"]);

function normModule(module) {
  const m = String(module || "").trim().toLowerCase();
  if (m === "maint") return "maintenance";
  return m;
}

function getAssignmentModuleDefinition(module) {
  const m = normModule(module);
  return ASSIGNMENT_MODULES.find((x) => x.module === m) || null;
}

function isValidAssignmentModule(module) {
  return !!getAssignmentModuleDefinition(module);
}

function normalizeCategoryMatch(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function categoryMatches(ruleCategory, inputCategory) {
  const want = normalizeCategoryMatch(ruleCategory);
  if (!want) return true;
  const got = normalizeCategoryMatch(inputCategory);
  return !!got && got === want;
}

function propertyMatches(rulePropertyCode, inputPropertyCode) {
  const ruleProp = String(rulePropertyCode || "*").trim().toUpperCase() || "*";
  const inputProp = String(inputPropertyCode || "").trim().toUpperCase();
  if (ruleProp === "*") return true;
  return ruleProp === inputProp;
}

module.exports = {
  ASSIGNMENT_MODULES,
  DEFAULT_ORG_ASSIGNMENT_RULES,
  VALID_TARGET_KINDS,
  normModule,
  getAssignmentModuleDefinition,
  isValidAssignmentModule,
  normalizeCategoryMatch,
  categoryMatches,
  propertyMatches,
  isValidRoleKey,
};
