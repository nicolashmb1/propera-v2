/**
 * Platform responsibility role catalog — stable keys used by resolver, escalation, and Settings UI.
 * Orgs assign staff to these slots; they do not create new keys in v1.
 * @see docs/RESPONSIBILITY_ROUTING_REFACTOR.md §3.0
 */

/** @typedef {'core'|'extended'} RoleTier */

/**
 * @type {Array<{
 *   roleKey: string,
 *   label: string,
 *   description: string,
 *   tier: RoleTier,
 *   allowMultiple: boolean,
 *   requiresPrimary: boolean,
 *   modules: string[],
 * }>}
 */
const ROLE_CATALOG = [
  {
    roleKey: "building_super",
    label: "Building lead",
    description: "Primary field contact for this property. Gets new maintenance tickets by default.",
    tier: "core",
    allowMultiple: true,
    requiresPrimary: true,
    modules: ["maintenance"],
  },
  {
    roleKey: "maintenance_tech",
    label: "Maintenance staff",
    description: "Shared maintenance coverage (can include multiple people).",
    tier: "core",
    allowMultiple: true,
    requiresPrimary: false,
    modules: ["maintenance"],
  },
  {
    roleKey: "office_pm",
    label: "Office / PM contact",
    description: "Main office contact for this property. Used for tenant deflect and escalation.",
    tier: "core",
    allowMultiple: true,
    requiresPrimary: true,
    modules: ["maintenance", "office"],
  },
  {
    roleKey: "owner",
    label: "Owner / executive",
    description: "Final escalation step. Usually not the default ticket assignee.",
    tier: "core",
    allowMultiple: false,
    requiresPrimary: true,
    modules: ["maintenance", "conflict"],
  },
  {
    roleKey: "office_staff",
    label: "Office staff",
    description: "Front desk or secretary — office inquiries route here when enabled.",
    tier: "extended",
    allowMultiple: true,
    requiresPrimary: true,
    modules: ["office"],
  },
  {
    roleKey: "leasing",
    label: "Leasing",
    description: "Leasing inquiries and applications when the leasing module is enabled.",
    tier: "extended",
    allowMultiple: true,
    requiresPrimary: true,
    modules: ["leasing"],
  },
  {
    roleKey: "cleaning_lead",
    label: "Cleaning coordinator",
    description: "Cleaning and turnover coordination for this property.",
    tier: "extended",
    allowMultiple: true,
    requiresPrimary: true,
    modules: ["cleaning"],
  },
];

const CORE_ROLE_KEYS = ROLE_CATALOG.filter((r) => r.tier === "core").map((r) => r.roleKey);

const DEFAULT_ENABLED_ROLE_KEYS = [
  "building_super",
  "maintenance_tech",
  "office_pm",
  "owner",
];

const DEFAULT_ESCALATION_CHAIN = ["building_super", "office_pm", "owner"];

/** Maps new role keys → legacy staff_assignments.role for tenant deflect parity until resolver ships. */
const LEGACY_ASSIGNMENT_ROLE_BY_KEY = {
  building_super: "SUPER|MAINTENANCE",
  maintenance_tech: "MAINTENANCE|MAINTENANCE",
  office_pm: "PM|GENERAL",
  office_staff: "PM|GENERAL",
  leasing: "LEASING|LEASING",
  owner: "OWNER|GENERAL",
};

function getRoleCatalog() {
  return ROLE_CATALOG.map((r) => ({ ...r }));
}

function getRoleDefinition(roleKey) {
  const key = String(roleKey || "").trim();
  return ROLE_CATALOG.find((r) => r.roleKey === key) || null;
}

function isValidRoleKey(roleKey) {
  return !!getRoleDefinition(roleKey);
}

function normalizeEnabledRoleKeys(raw) {
  const set = new Set(CORE_ROLE_KEYS);
  const input = Array.isArray(raw) ? raw : DEFAULT_ENABLED_ROLE_KEYS;
  for (const k of input) {
    const key = String(k || "").trim();
    if (isValidRoleKey(key)) set.add(key);
  }
  return ROLE_CATALOG.filter((r) => set.has(r.roleKey)).map((r) => r.roleKey);
}

module.exports = {
  ROLE_CATALOG,
  CORE_ROLE_KEYS,
  DEFAULT_ENABLED_ROLE_KEYS,
  DEFAULT_ESCALATION_CHAIN,
  LEGACY_ASSIGNMENT_ROLE_BY_KEY,
  getRoleCatalog,
  getRoleDefinition,
  isValidRoleKey,
  normalizeEnabledRoleKeys,
};
