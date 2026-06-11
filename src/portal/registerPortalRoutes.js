/**
 * Portal read/write API — GAS `?path=tickets|properties|tenants` + roster CRUD for propera-app.
 */
const { listTicketsForPortal, listPropertiesForPortal } = require("../dal/portalTicketsRead");
const {
  listTenantsForPortal,
  createTenantForPortal,
  updateTenantForPortal,
  deactivateTenantForPortal,
} = require("../dal/portalTenants");
const {
  createProgramRun,
  previewProgramRunExpansion,
  deleteProgramRun,
  listProgramRuns,
  getProgramRunById,
  completeProgramLine,
  reopenProgramLine,
  setProgramLineVendor,
  setProgramLineStaff,
  addProgramLine,
  deleteProgramLine,
  reorderProgramLines,
} = require("../dal/programRuns");
const { createTicketFromProgramLine } = require("../pm/createTicketFromProgramLine");
const {
  createSavedProgram,
  listSavedPrograms,
  archiveSavedProgram,
} = require("../dal/savedPrograms");
const { patchPropertyProgramExpansionProfile } = require("../dal/portalPropertyProgramProfile");
const { listPropertyLocationsForPortal } = require("../dal/propertyLocations");
const {
  listTurnovers,
  getTurnoverById,
  startTurnover,
  patchTurnover,
  addTurnoverItem,
  updateTurnoverItem,
  reorderTurnoverItems,
  linkTicketToTurnoverItem,
  createTicketFromTurnoverItem,
  markTurnoverReady,
} = require("../dal/turnovers");
const {
  listUnitOccupancies,
  getUnitOccupancyById,
  getCurrentUnitOccupancy,
  closeUnitOccupancy,
  patchUnitOccupancy,
} = require("../dal/unitOccupancies");
const {
  listUnitAssets,
  getUnitAssetById,
  addUnitAsset,
  updateUnitAsset,
  markUnitAssetInactive,
  replaceUnitAsset,
} = require("../dal/unitAssets");
const {
  syncAfterTenantDeactivated,
  syncAfterLeaseMarkedVacating,
  closeOccupancyWithOptions,
  syncAfterProspectSigned,
  openOccupancyWithSync,
  syncLeaseSnapshotToCurrentOccupancy,
} = require("../lifecycle/unitLifecycleOrchestrator");
const { listUnitEpisodeTicketHistory } = require("../dal/unitEpisodeTicketHistory");
const { getSupabase } = require("../db/supabase");
const { verifyPortalRequest } = require("./portalAuth");
const {
  turnoverEngineEnabled,
  unitLifecycleEnabled,
  leasingEngineEnabled,
  financeTicketCostsEnabled,
  openDeckDayChartEnabled,
  canManageJarvisStaffSettings,
} = require("../config/env");
const { fetchTicketDayCurve, defaultCurveDate } = require("./ticketDayCurve");
const {
  listTicketCostEntriesForPortal,
  listProgramRunCostEntriesForPortal,
  createTicketCostEntryForPortal,
  createProgramRunCostEntryForPortal,
  updateTicketCostEntryForPortal,
} = require("../dal/ticketCostEntries");
const {
  applyPortalTicketAssignment,
  listStaffAssignableToProperty,
  listVendorsForAssignment,
  createVendorForPortal,
} = require("../dal/portalTicketAssignment");
const {
  applyPortalTicketTenantChange,
  listTenantsForUnitTicket,
} = require("../dal/portalTicketTenant");
const {
  upsertPushSubscription,
  deactivatePushSubscription,
  getVapidPublicKeyForClient,
} = require("./pushNotifications");
const { portalPushEnabled } = require("../config/env");
const { handleJarvisPendingProposal } = require("./handleJarvisPendingProposal");
const {
  listStaffJarvisSettingsForOrg,
  patchStaffJarvisSettingForOrg,
} = require("../dal/jarvisStaffSettings");
const { attachPortalOrgContextMiddleware } = require("./resolvePortalOrgContext");
const {
  canManageOrgSettings,
  getOrganizationForPortal,
  patchOrganizationForPortal,
  listStaffForOrg,
  createStaffForPortal,
  patchStaffForPortal,
  listPortalUsersForOrg,
  createPortalUserForOrg,
  patchPortalUserForOrg,
  deletePortalUserForOrg,
  listVendorsForOrg,
  patchVendorForOrg,
  listPropertiesForOrg,
  createPropertyForOrg,
  patchPropertyForOrg,
  listStaffAssignmentsForOrg,
  createStaffAssignmentForOrg,
  patchStaffAssignmentForOrg,
  deleteStaffAssignmentForOrg,
} = require("../dal/portalOrgSettings");
const {
  listOrgChannelsForPortal,
  patchOrgChannelForPortal,
} = require("../dal/portalOrgChannels");
const {
  listPoliciesForOrgPortal,
  patchPolicyForOrgPortal,
  clearPolicyOverrideForOrgPortal,
  listPolicyAuditForOrgPortal,
} = require("../dal/portalOrgPolicies");
const {
  listBalanceRemindersForPortal,
  patchBalanceReminderSettingsForPortal,
  patchBalanceReminderRuleForPortal,
  createBalanceReminderRuleForPortal,
  deleteBalanceReminderRuleForPortal,
} = require("../dal/portalBalanceReminders");
const {
  previewBalanceReminderMessage,
  draftBalanceReminderMessage,
  previewOrgBroadcastSms,
} = require("../communication/balanceReminderMessage");
const {
  getTeamSettingsBundleForOrg,
  patchOrgResponsibilityPrefs,
  patchEscalationConfigForOrg,
  savePropertyCoverageForOrg,
  saveGlobalOwnerForOrg,
  copyPropertyCoverageToAll,
} = require("../dal/portalOrgResponsibility");
const { patchAssignmentRulesForOrg } = require("../dal/portalOrgAssignmentRules");
const {
  listExpiringLeasesForPortal,
  patchLeaseRenewalStatus,
  listProspectsForPortal,
  createProspectForPortal,
  patchProspectForPortal,
  deleteProspectForPortal,
} = require("../dal/leasingProspects");

function portalOrgFromReq(req) {
  return (
    req.portalOrg || {
      orgId: "",
      propertyCodes: [],
      propertyCodesUpper: new Set(),
    }
  );
}

function registerPortalReadRoutes(app) {
  async function sendTickets(req, res) {
    try {
      const org = portalOrgFromReq(req);
      const rows = await listTicketsForPortal({ orgScope: org });
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  async function sendProperties(req, res) {
    try {
      const org = portalOrgFromReq(req);
      const rows = await listPropertiesForPortal({ orgScope: org });
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  async function sendTenants(req, res) {
    try {
      const includeInactive =
        String(req.query.includeInactive || "").trim() === "1";
      const org = portalOrgFromReq(req);
      const rows = await listTenantsForPortal({
        includeInactive,
        orgId: org.orgId,
      });
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  function gate(handler) {
    const sb = getSupabase();
    const orgMw = sb ? attachPortalOrgContextMiddleware(sb) : null;
    return (req, res, next) => {
      if (!verifyPortalRequest(req)) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
      if (orgMw) {
        return orgMw(req, res, () => handler(req, res, next));
      }
      return handler(req, res, next);
    };
  }

  /** Owner/Ops/PM only — requires portal user JWT (not portal token alone). */
  function gateSettings(handler) {
    return gate(async (req, res, next) => {
      const org = portalOrgFromReq(req);
      if (org.source !== "jwt" || !canManageOrgSettings(org.portalRole)) {
        return res.status(403).json({ ok: false, error: "settings_forbidden" });
      }
      return handler(req, res, next);
    });
  }

  /** Jarvis per-staff toggles — allowlisted portal login emails only (`PROPERA_JARVIS_SETTINGS_ADMIN_EMAILS`). */
  function gateJarvisStaffSettings(handler) {
    return gate(async (req, res, next) => {
      const org = portalOrgFromReq(req);
      if (!canManageJarvisStaffSettings(org)) {
        return res.status(403).json({ ok: false, error: "jarvis_settings_forbidden" });
      }
      return handler(req, res, next);
    });
  }

  /** Portal token + opt-in turnover flag (`PROPERA_TURNOVER_ENGINE_ENABLED=1`). */
  function gateTurnover(handler) {
    return gate(async (req, res, next) => {
      if (!turnoverEngineEnabled()) {
        return res.status(404).json({ ok: false, error: "turnover_engine_disabled" });
      }
      return handler(req, res, next);
    });
  }

  /** Portal token + unit lifecycle flag (`PROPERA_UNIT_LIFECYCLE_ENABLED=1`). */
  function gateUnitLifecycle(handler) {
    return gate(async (req, res, next) => {
      if (!unitLifecycleEnabled()) {
        return res.status(404).json({ ok: false, error: "unit_lifecycle_disabled" });
      }
      return handler(req, res, next);
    });
  }

  /** Portal token + opt-in leasing flag (`PROPERA_LEASING_ENGINE_ENABLED=1`). */
  function gateLeasing(handler) {
    return gate(async (req, res, next) => {
      if (!leasingEngineEnabled()) {
        return res.status(404).json({ ok: false, error: "leasing_engine_disabled" });
      }
      return handler(req, res, next);
    });
  }

  /** Ticket costs — `PROPERA_FINANCE_ENABLED=1` + `PROPERA_FINANCE_TICKET_COSTS_ENABLED=1`. */
  function gateFinance(handler) {
    return gate(async (req, res, next) => {
      if (!financeTicketCostsEnabled()) {
        return res.status(404).json({ ok: false, error: "finance_disabled" });
      }
      return handler(req, res, next);
    });
  }

  /** Mobile open-deck day chart — `PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1`. */
  function gateOpenDeckDayChart(handler) {
    return gate(async (req, res, next) => {
      if (!openDeckDayChartEnabled()) {
        return res.status(404).json({ ok: false, error: "open_deck_day_chart_disabled" });
      }
      return handler(req, res, next);
    });
  }

  /** GAS web-app style: `baseUrl?path=tickets` (propera-app remote mode). */
  app.get("/api/portal/gas-compat", gate(async (req, res) => {
    const path = String(req.query.path || "").trim().toLowerCase();
    if (path === "tickets") return sendTickets(req, res);
    if (path === "properties") return sendProperties(req, res);
    if (path === "tenants") return sendTenants(req, res);
    return res.status(400).json({ ok: false, error: "unknown_path" });
  }));

  app.get(
    "/api/portal/tickets/day-curve",
    gateOpenDeckDayChart(async (req, res) => {
      try {
        const date = defaultCurveDate(req.query.date);
        const propertyCode = String(req.query.propertyCode || req.query.property || "").trim();
        const out = await fetchTicketDayCurve({ date, propertyCode });
        if (!out.ok) {
          const status = out.error === "invalid_date" ? 400 : 500;
          return res.status(status).json(out);
        }
        return res.status(200).json(out);
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  /**
   * Same portal token as GET gas-compat — POST body carries payload.
   * Used when clients only bookmark …/gas-compat (Proxies may not route extra /api/portal/* paths).
   */
  app.post("/api/portal/gas-compat", gate(async (req, res) => {
    const path = String(req.query.path || "").trim().toLowerCase();
    if (path === "program-runs-preview") {
      try {
        const body = req.body || {};
        const out = await previewProgramRunExpansion({
          property: body.property,
          propertyCode: body.propertyCode,
          templateKey: body.templateKey,
          savedProgramId: body.savedProgramId,
          expansionType: body.expansionType,
          includedScopeLabels: Array.isArray(body.includedScopeLabels)
            ? body.includedScopeLabels
            : undefined,
        });
        if (!out.ok) {
          return res.status(400).json({ ok: false, error: out.error || "preview_failed" });
        }
        return res.status(200).json({
          ok: true,
          lines: out.lines,
          expansion_type: out.expansion_type,
          template_key: out.template_key,
          saved_program_id: out.saved_program_id,
          property_code: out.property_code,
        });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    }
    if (path === "program-runs-delete") {
      try {
        const body = req.body || {};
        const id = String(body.id || body.runId || "").trim();
        const out = await deleteProgramRun(id, { traceId: req.traceId });
        if (!out.ok) {
          const code = out.error === "not_found" ? 404 : 400;
          return res.status(code).json({ ok: false, error: out.error || "delete_failed" });
        }
        return res.status(200).json({ ok: true });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    }
    return res.status(400).json({ ok: false, error: "unknown_post_path" });
  }));

  app.get("/api/portal/tickets", gate(sendTickets));

  app.get(
    "/api/portal/properties/:code/staff-for-assignment",
    gate(async (req, res) => {
      try {
        const sb = getSupabase();
        if (!sb) {
          return res.status(503).json({ ok: false, error: "no_db" });
        }
        const out = await listStaffAssignableToProperty(sb, req.params.code);
        if (!out.ok) {
          const status = out.error === "invalid_property_code" ? 400 : 500;
          return res.status(status).json({ ok: false, error: out.error || "list_failed" });
        }
        return res.status(200).json({ ok: true, staff: out.staff });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.get("/api/portal/vendors-for-assignment", gate(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) {
        return res.status(503).json({ ok: false, error: "no_db" });
      }
      const org = portalOrgFromReq(req);
      const out = await listVendorsForAssignment(sb, { orgId: org.orgId });
      if (!out.ok) {
        const status = out.error === "vendors_migration_required" ? 503 : 500;
        return res.status(status).json({ ok: false, error: out.error || "list_failed" });
      }
      return res.status(200).json({ ok: true, vendors: out.vendors });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/vendors", gate(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) {
        return res.status(503).json({ ok: false, error: "no_db" });
      }
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const org = portalOrgFromReq(req);
      const out = await createVendorForPortal(sb, { ...body, orgId: org.orgId });
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 && out.status < 600
            ? out.status
            : out.error === "vendors_migration_required"
              ? 503
              : 400;
        return res.status(status).json({ ok: false, error: out.error || "create_failed" });
      }
      return res.status(201).json({ ok: true, vendor: out.vendor });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get(
    "/api/portal/properties/:code/tenants-for-unit",
    gate(async (req, res) => {
      try {
        const sb = getSupabase();
        if (!sb) {
          return res.status(503).json({ ok: false, error: "no_db" });
        }
        const unit = String(req.query.unit ?? req.query.unit_label ?? "").trim();
        const out = await listTenantsForUnitTicket(sb, req.params.code, unit);
        if (!out.ok) {
          const status = out.error === "invalid_property_or_unit" ? 400 : 500;
          return res.status(status).json({ ok: false, error: out.error || "list_failed" });
        }
        return res.status(200).json({ ok: true, tenants: out.tenants });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.post("/api/portal/tickets/:ticketId/tenant", gate(async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const auth = String(req.get("authorization") || "").trim();
      const m = /^Bearer\s+(\S+)/i.exec(auth);
      const portalUserAccessToken = m ? m[1] : "";
      const out = await applyPortalTicketTenantChange({
        ticketLookupHint: req.params.ticketId,
        ticketKeyHint: body.ticket_key ?? body.ticketKey,
        ticketRowIdHint: body.ticket_row_id ?? body.ticketRowId,
        tenantPhoneE164: body.tenant_phone_e164 ?? body.tenantPhoneE164,
        traceId: req.traceId,
        portalUserAccessToken,
      });
      if (!out.ok) {
        const code = out.status >= 400 && out.status < 600 ? out.status : 400;
        return res.status(code).json({ ok: false, error: out.error || "tenant_change_failed" });
      }
      return res.status(200).json({
        ok: true,
        ticketId: out.ticketId,
        ticketRowId: out.ticketRowId,
        tenantPhoneE164: out.tenantPhoneE164,
        tenantDisplayName: out.tenantDisplayName,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/tickets/:ticketId/assignment", gate(async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const auth = String(req.get("authorization") || "").trim();
      const m = /^Bearer\s+(\S+)/i.exec(auth);
      const portalUserAccessToken = m ? m[1] : "";
      const out = await applyPortalTicketAssignment({
        ticketLookupHint: req.params.ticketId,
        ticketKeyHint: body.ticket_key ?? body.ticketKey,
        ticketRowIdHint: body.ticket_row_id ?? body.ticketRowId,
        assignedStaffId:
          Object.prototype.hasOwnProperty.call(body, "assigned_staff_id")
            ? body.assigned_staff_id
            : body.assignedStaffId,
        assignedVendorId:
          Object.prototype.hasOwnProperty.call(body, "assigned_vendor_id")
            ? body.assigned_vendor_id
            : body.assignedVendorId,
        assignmentNote: body.assignment_note ?? body.assignmentNote,
        dispatchOnAssign: body.dispatch_on_assign ?? body.dispatchOnAssign,
        dispatchOnly: body.dispatch_only === true || body.dispatchOnly === true,
        forceResend: body.force_resend === true || body.forceResend === true,
        traceId: req.traceId,
        portalUserAccessToken,
      });
      if (!out.ok) {
        const code =
          out.status >= 400 && out.status < 600 ? out.status : 400;
        return res.status(code).json({ ok: false, error: out.error || "assignment_failed" });
      }
      return res.status(200).json({
        ok: true,
        ticketId: out.ticketId,
        ticketRowId: out.ticketRowId,
        assignedStaffId: out.assignedStaffId,
        assignedVendorId: out.assignedVendorId,
        assignedType: out.assignedType,
        assignedDisplayName: out.assignedDisplayName,
        assignmentSource: out.assignmentSource,
        assigned: out.assigned,
        assignmentSkipped: out.assignmentSkipped,
        dispatched: out.dispatched,
        dispatchSkippedReason: out.dispatchSkippedReason,
        dispatchError: out.dispatchError,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get(
    "/api/portal/tickets/:ticketRowId/ticket-cost-entries",
    gateFinance(async (req, res) => {
      try {
        const out = await listTicketCostEntriesForPortal(req.params.ticketRowId);
        if (!out.ok) {
          const code = out.error === "ticket_not_found" ? 404 : 500;
          return res.status(code).json({ ok: false, error: out.error || "list_failed" });
        }
        return res.status(200).json({ ok: true, entries: out.entries });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.post(
    "/api/portal/tickets/:ticketRowId/ticket-cost-entries",
    gateFinance(async (req, res) => {
      try {
        const out = await createTicketCostEntryForPortal(req.params.ticketRowId, req.body || {});
        if (!out.ok) {
          const code =
            out.error === "ticket_not_found"
              ? 404
              : out.error === "imported_history_read_only"
                ? 403
                : 400;
          return res.status(code).json({ ok: false, error: out.error || "create_failed" });
        }
        return res.status(201).json({ ok: true, entry: out.entry });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.patch(
    "/api/portal/ticket-cost-entries/:entryId",
    gateFinance(async (req, res) => {
      try {
        const out = await updateTicketCostEntryForPortal(req.params.entryId, req.body || {});
        if (!out.ok) {
          const code =
            out.error === "not_found" || out.error === "ticket_not_found"
              ? 404
              : out.error === "imported_history_read_only"
                ? 403
                : 400;
          return res.status(code).json({ ok: false, error: out.error || "update_failed" });
        }
        return res.status(200).json({ ok: true, entry: out.entry });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.get("/api/portal/properties", gate(sendProperties));

  app.get(
    "/api/portal/properties/:code/property-locations",
    gate(async (req, res) => {
      try {
        const code = String(req.params.code || "").trim();
        const out = await listPropertyLocationsForPortal(code);
        if (!out.ok) {
          const status =
            out.error === "invalid_property_code" ? 400 : 500;
          return res.status(status).json({ ok: false, error: out.error || "list_failed" });
        }
        return res.status(200).json({ ok: true, locations: out.locations });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.patch(
    "/api/portal/properties/:code/program-expansion-profile",
    gate(async (req, res) => {
      try {
        const code = String(req.params.code || "").trim();
        const out = await patchPropertyProgramExpansionProfile(
          code,
          req.body || {},
          req.traceId
        );
        if (!out.ok) {
          const status =
            out.error === "unknown_property" || out.error === "invalid_property_code"
              ? 404
              : 400;
          return res.status(status).json({ ok: false, error: out.error || "update_failed" });
        }
        return res.status(200).json({
          ok: true,
          programExpansionProfile: out.programExpansionProfile,
        });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.get("/api/portal/tenants", gate(sendTenants));

  app.post("/api/portal/tenants", gate(async (req, res) => {
    try {
      const out = await createTenantForPortal(req.body || {});
      if (!out.ok) {
        return res.status(400).json({ ok: false, error: out.error || "create_failed" });
      }
      return res.status(201).json({ ok: true, tenant: out.tenant });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.patch("/api/portal/tenants/:id", gate(async (req, res) => {
    try {
      const out = await updateTenantForPortal(req.params.id, req.body || {});
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "update_failed" });
      }
      return res.status(200).json({ ok: true, tenant: out.tenant });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.delete("/api/portal/tenants/:id", gate(async (req, res) => {
    try {
      const out = await deactivateTenantForPortal(req.params.id);
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "delete_failed" });
      }
      const sync = await syncAfterTenantDeactivated(req.params.id, { traceId: req.traceId });
      return res.status(200).json({
        ok: true,
        lifecycle_sync: sync.ok ? sync : { ok: false, error: sync.error },
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get("/api/portal/saved-programs", gate(async (req, res) => {
    try {
      const code = String(req.query.propertyCode || "").trim().toUpperCase();
      if (!code) {
        return res.status(400).json({ ok: false, error: "missing_property_code" });
      }
      const rows = await listSavedPrograms(code);
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/saved-programs", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await createSavedProgram({
        propertyCode: body.propertyCode,
        displayName: body.displayName,
        expansionType: body.expansionType,
        defaultIncludedScopeLabels: Array.isArray(body.defaultIncludedScopeLabels)
          ? body.defaultIncludedScopeLabels
          : undefined,
        createdBy: body.createdBy || "PORTAL",
      });
      if (!out.ok) {
        return res.status(400).json({ ok: false, error: out.error || "create_failed" });
      }
      return res.status(201).json({ ok: true, program: out.program });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.delete("/api/portal/saved-programs/:id", gate(async (req, res) => {
    try {
      const out = await archiveSavedProgram(req.params.id);
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "archive_failed" });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  /** Turnover Engine V1 — unit walkthrough + readiness */
  app.get("/api/portal/turnovers", gateTurnover(async (req, res) => {
    try {
      const property_code = req.query.property_code != null ? String(req.query.property_code) : "";
      const unit_catalog_id =
        req.query.unit_catalog_id != null ? String(req.query.unit_catalog_id) : "";
      const out = await listTurnovers({ property_code, unit_catalog_id });
      if (!out.ok) {
        return res.status(500).json({ ok: false, error: out.error || "list_failed" });
      }
      return res.status(200).json({ ok: true, turnovers: out.turnovers });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/turnovers", gateTurnover(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await startTurnover({
        property_code: body.property_code ?? body.propertyCode,
        unit_catalog_id: body.unit_catalog_id ?? body.unitCatalogId,
        target_ready_date: body.target_ready_date ?? body.targetReadyDate,
        summary: body.summary,
        created_by: body.created_by ?? body.createdBy ?? "",
        traceId: req.traceId,
      });
      if (!out.ok) {
        const code =
          out.error === "active_turnover_exists"
            ? 409
            : out.error === "unit_property_mismatch" || out.error === "unknown_unit"
              ? 400
              : 400;
        return res.status(code).json({
          ok: false,
          error: out.error || "start_failed",
          existing_turnover_id: out.existing_turnover_id,
        });
      }
      return res.status(201).json({
        ok: true,
        turnover_id: out.turnover_id,
        turnover: out.turnover,
        items: out.items,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get("/api/portal/turnovers/:id", gateTurnover(async (req, res) => {
    try {
      const out = await getTurnoverById(req.params.id, true);
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 500;
        return res.status(code).json({ ok: false, error: out.error || "get_failed" });
      }
      return res.status(200).json({ ok: true, turnover: out.turnover, items: out.items });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.patch("/api/portal/turnovers/:id", gateTurnover(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await patchTurnover(req.params.id, body, { traceId: req.traceId });
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, turnover: out.turnover, items: out.items });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/turnovers/:id/mark-ready", gateTurnover(async (req, res) => {
    try {
      const out = await markTurnoverReady(req.params.id, { traceId: req.traceId });
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 422;
        return res.status(code).json({
          ok: false,
          error: out.error || "mark_ready_failed",
          reasons: out.reasons || [],
        });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/turnovers/:id/items", gateTurnover(async (req, res) => {
    try {
      const out = await addTurnoverItem(req.params.id, req.body || {}, { traceId: req.traceId });
      if (!out.ok) {
        const code =
          out.error === "not_found"
            ? 404
            : out.error === "turnover_not_active"
              ? 409
              : 400;
        return res.status(code).json({ ok: false, error: out.error || "add_item_failed" });
      }
      return res.status(201).json({ ok: true, item_id: out.item_id });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.patch("/api/portal/turnovers/:id/items/:itemId", gateTurnover(async (req, res) => {
    try {
      const out = await updateTurnoverItem(req.params.id, req.params.itemId, req.body || {}, {
        traceId: req.traceId,
      });
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "update_item_failed" });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/turnovers/:id/items/reorder", gateTurnover(async (req, res) => {
    try {
      const body = req.body || {};
      const ordered =
        body.ordered_ids || body.orderedIds || body.ids || [];
      const out = await reorderTurnoverItems(req.params.id, ordered, { traceId: req.traceId });
      if (!out.ok) {
        const code = out.error === "unknown_item" ? 400 : 400;
        return res.status(code).json({ ok: false, error: out.error || "reorder_failed" });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/turnovers/:id/items/:itemId/create-ticket", gateTurnover(async (req, res) => {
    try {
      const body = req.body || {};
      const sb = getSupabase();
      if (!sb) {
        return res.status(503).json({ ok: false, error: "no_db" });
      }
      const auth = String(req.get("authorization") || "").trim();
      const m = /^Bearer\s+(\S+)/i.exec(auth);
      const jwt = m ? m[1] : "";
      if (!jwt) {
        return res.status(401).json({ ok: false, error: "missing_portal_access_token" });
      }
      const { resolvePortalStaffActorFromJwt } = require("../portal/resolvePortalStaffActor");
      const rAct = await resolvePortalStaffActorFromJwt(sb, jwt);
      if (!rAct.ok || !rAct.changedBy) {
        return res.status(403).json({ ok: false, error: rAct.error || "portal_actor_unresolved" });
      }
      const out = await createTicketFromTurnoverItem({
        turnoverId: req.params.id,
        itemId: req.params.itemId,
        actorPhoneE164: body.actor_phone_e164 ?? body.actorPhoneE164 ?? "",
        traceId: req.traceId,
        portalTicketAudit: rAct.changedBy,
      });
      if (!out.ok) {
        const code =
          out.error === "item_not_found" || out.error === "turnover_not_found"
            ? 404
            : out.error === "item_already_linked"
              ? 409
              : 400;
        return res.status(code).json({ ok: false, error: out.error || "create_ticket_failed" });
      }
      return res.status(201).json({
        ok: true,
        ticket_id: out.ticket_id,
        work_item_id: out.work_item_id,
        ticket_key: out.ticket_key,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/turnovers/:id/items/:itemId/link-ticket", gateTurnover(async (req, res) => {
    try {
      const body = req.body || {};
      const sb = getSupabase();
      if (!sb) {
        return res.status(503).json({ ok: false, error: "no_db" });
      }
      const auth = String(req.get("authorization") || "").trim();
      const m = /^Bearer\s+(\S+)/i.exec(auth);
      const jwt = m ? m[1] : "";
      if (!jwt) {
        return res.status(401).json({ ok: false, error: "missing_portal_access_token" });
      }
      const { resolvePortalStaffActorFromJwt } = require("../portal/resolvePortalStaffActor");
      const rAct = await resolvePortalStaffActorFromJwt(sb, jwt);
      if (!rAct.ok || !rAct.changedBy) {
        return res.status(403).json({ ok: false, error: rAct.error || "portal_actor_unresolved" });
      }
      const hint = body.ticket_id ?? body.ticketId ?? body.human_ticket_id ?? "";
      const out = await linkTicketToTurnoverItem(req.params.id, req.params.itemId, hint, {
        traceId: req.traceId,
        portalTicketAudit: rAct.changedBy,
      });
      if (!out.ok) {
        const code =
          out.error === "item_not_found" ? 404 : out.error === "ticket_not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "link_failed" });
      }
      return res.status(200).json({ ok: true, ticket_id: out.ticket_id });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  /** Unit occupancies V1 — residency episodes (see docs/UNIT_LIFECYCLE_BUILD_PLAN.md) */
  app.get("/api/portal/occupancies", gateUnitLifecycle(async (req, res) => {
    try {
      const property_code = req.query.property_code != null ? String(req.query.property_code) : "";
      const unit_catalog_id =
        req.query.unit_catalog_id != null ? String(req.query.unit_catalog_id) : "";
      const status = req.query.status != null ? String(req.query.status) : "";
      const out = await listUnitOccupancies({ property_code, unit_catalog_id, status });
      if (!out.ok) {
        return res.status(500).json({ ok: false, error: out.error || "list_failed" });
      }
      return res.status(200).json({ ok: true, occupancies: out.occupancies });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get("/api/portal/occupancies/current", gateUnitLifecycle(async (req, res) => {
    try {
      const unit_catalog_id =
        req.query.unit_catalog_id != null
          ? String(req.query.unit_catalog_id)
          : req.query.unitCatalogId != null
            ? String(req.query.unitCatalogId)
            : "";
      if (!unit_catalog_id.trim()) {
        return res.status(400).json({ ok: false, error: "missing_unit_catalog_id" });
      }
      const out = await getCurrentUnitOccupancy(unit_catalog_id);
      if (!out.ok) {
        return res.status(500).json({ ok: false, error: out.error || "get_failed" });
      }
      return res.status(200).json({ ok: true, occupancy: out.occupancy });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get("/api/portal/occupancies/:id", gateUnitLifecycle(async (req, res) => {
    try {
      const out = await getUnitOccupancyById(req.params.id);
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 500;
        return res.status(code).json({ ok: false, error: out.error || "get_failed" });
      }
      return res.status(200).json({ ok: true, occupancy: out.occupancy });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/occupancies/open", gateUnitLifecycle(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await openOccupancyWithSync({
        property_code: body.property_code ?? body.propertyCode,
        unit_catalog_id: body.unit_catalog_id ?? body.unitCatalogId,
        tenant_roster_id: body.tenant_roster_id ?? body.tenantRosterId,
        started_at: body.started_at ?? body.startedAt,
        lease_snapshot_json: body.lease_snapshot_json ?? body.leaseSnapshotJson,
        created_by: body.created_by ?? body.createdBy ?? "",
        traceId: req.traceId,
      });
      if (!out.ok) {
        const code =
          out.error === "active_occupancy_exists"
            ? 409
            : out.error === "unit_property_mismatch" ||
                out.error === "unknown_unit" ||
                out.error === "tenant_property_mismatch" ||
                out.error === "tenant_unit_mismatch" ||
                out.error === "unknown_tenant"
              ? 400
              : 500;
        return res.status(code).json({
          ok: false,
          error: out.error || "open_failed",
          existing_occupancy_id: out.existing_occupancy_id,
        });
      }
      return res.status(201).json({
        ok: true,
        occupancy_id: out.occupancy_id,
        occupancy: out.occupancy,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/occupancies/:id/close", gateUnitLifecycle(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await closeOccupancyWithOptions(req.params.id, {
        ended_at: body.ended_at ?? body.endedAt,
        move_out_turnover_id: body.move_out_turnover_id ?? body.moveOutTurnoverId,
        start_turnover: body.start_turnover === true || body.startTurnover === true,
        traceId: req.traceId,
      });
      if (!out.ok) {
        const code =
          out.error === "not_found"
            ? 404
            : out.error === "occupancy_not_current" || out.error === "ended_before_started"
              ? 409
              : 400;
        return res.status(code).json({ ok: false, error: out.error || "close_failed" });
      }
      return res.status(200).json({
        ok: true,
        occupancy: out.occupancy,
        turnover_id: out.turnover_id || null,
        turnover_started: !!out.turnover_started,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get(
    "/api/portal/units/:unitCatalogId/episode-ticket-history",
    gateUnitLifecycle(async (req, res) => {
      try {
        const propertyCode = req.query.property_code ?? req.query.propertyCode;
        const out = await listUnitEpisodeTicketHistory({
          property_code: propertyCode,
          unit_catalog_id: req.params.unitCatalogId,
        });
        if (!out.ok) {
          return res.status(400).json({ ok: false, error: out.error || "history_failed" });
        }
        return res.status(200).json({ ok: true, episodes: out.episodes });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.post(
    "/api/portal/units/:unitCatalogId/sync-lease-occupancy",
    gateUnitLifecycle(async (req, res) => {
      try {
        const out = await syncLeaseSnapshotToCurrentOccupancy(req.params.unitCatalogId, {
          traceId: req.traceId,
        });
        if (!out.ok) {
          return res.status(400).json({ ok: false, error: out.error || "sync_failed" });
        }
        return res.status(200).json({ ok: true, lifecycle_sync: out });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.patch("/api/portal/occupancies/:id", gateUnitLifecycle(async (req, res) => {
    try {
      const out = await patchUnitOccupancy(req.params.id, req.body || {}, { traceId: req.traceId });
      if (!out.ok) {
        const code =
          out.error === "not_found"
            ? 404
            : out.error === "occupancy_is_past"
              ? 409
              : 400;
        return res.status(code).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, occupancy: out.occupancy });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  /** Unit assets V1 — installed equipment (see docs/UNIT_LIFECYCLE_BUILD_PLAN.md Phase 3) */
  app.get("/api/portal/unit-assets", gateUnitLifecycle(async (req, res) => {
    try {
      const property_code = req.query.property_code != null ? String(req.query.property_code) : "";
      const unit_catalog_id =
        req.query.unit_catalog_id != null ? String(req.query.unit_catalog_id) : "";
      const status = req.query.status != null ? String(req.query.status) : "";
      const out = await listUnitAssets({ property_code, unit_catalog_id, status });
      if (!out.ok) {
        return res.status(500).json({ ok: false, error: out.error || "list_failed" });
      }
      return res.status(200).json({ ok: true, assets: out.assets });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get("/api/portal/unit-assets/:id", gateUnitLifecycle(async (req, res) => {
    try {
      const out = await getUnitAssetById(req.params.id);
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 500;
        return res.status(code).json({ ok: false, error: out.error || "get_failed" });
      }
      return res.status(200).json({ ok: true, asset: out.asset });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/unit-assets", gateUnitLifecycle(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await addUnitAsset({
        property_code: body.property_code ?? body.propertyCode,
        unit_catalog_id: body.unit_catalog_id ?? body.unitCatalogId,
        category: body.category,
        asset_type: body.asset_type ?? body.assetType,
        make: body.make,
        model: body.model,
        serial_number: body.serial_number ?? body.serialNumber,
        installed_at: body.installed_at ?? body.installedAt,
        installed_by: body.installed_by ?? body.installedBy,
        warranty_start: body.warranty_start ?? body.warrantyStart,
        warranty_end: body.warranty_end ?? body.warrantyEnd,
        nameplate_photo_url: body.nameplate_photo_url ?? body.nameplatePhotoUrl,
        source_ticket_id: body.source_ticket_id ?? body.sourceTicketId,
        source_turnover_id: body.source_turnover_id ?? body.sourceTurnoverId,
        metadata_json: body.metadata_json ?? body.metadataJson,
        created_by: body.created_by ?? body.createdBy ?? "",
        traceId: req.traceId,
      });
      if (!out.ok) {
        const code =
          out.error === "active_asset_type_exists"
            ? 409
            : out.error === "unit_property_mismatch" ||
                out.error === "unknown_unit" ||
                out.error === "missing_property_unit_or_type"
              ? 400
              : 500;
        return res.status(code).json({
          ok: false,
          error: out.error || "add_failed",
          existing_asset_id: out.existing_asset_id,
        });
      }
      return res.status(201).json({ ok: true, asset: out.asset });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.patch("/api/portal/unit-assets/:id", gateUnitLifecycle(async (req, res) => {
    try {
      const out = await updateUnitAsset(req.params.id, req.body || {}, { traceId: req.traceId });
      if (!out.ok) {
        const code =
          out.error === "not_found"
            ? 404
            : out.error === "asset_not_active" || out.error === "active_asset_type_exists"
              ? 409
              : 400;
        return res.status(code).json({
          ok: false,
          error: out.error || "patch_failed",
          existing_asset_id: out.existing_asset_id,
        });
      }
      return res.status(200).json({ ok: true, asset: out.asset });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/unit-assets/:id/remove", gateUnitLifecycle(async (req, res) => {
    try {
      const out = await markUnitAssetInactive(req.params.id, "removed", { traceId: req.traceId });
      if (!out.ok) {
        const code =
          out.error === "not_found"
            ? 404
            : out.error === "asset_not_active"
              ? 409
              : 400;
        return res.status(code).json({ ok: false, error: out.error || "remove_failed" });
      }
      return res.status(200).json({ ok: true, asset: out.asset });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/unit-assets/:id/replace", gateUnitLifecycle(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await replaceUnitAsset(req.params.id, body, { traceId: req.traceId });
      if (!out.ok) {
        const code =
          out.error === "not_found"
            ? 404
            : out.error === "asset_not_active" || out.error === "active_asset_type_exists"
              ? 409
              : 400;
        return res.status(code).json({
          ok: false,
          error: out.error || "replace_failed",
          existing_asset_id: out.existing_asset_id,
        });
      }
      return res.status(200).json({
        ok: true,
        asset: out.asset,
        replaced_asset_id: out.replaced_asset_id,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  /** Unit asset nameplate OCR — draft fields for staff confirm (Phase 4 lifecycle). */
  app.post("/api/portal/scan-unit-asset-nameplate", gateUnitLifecycle(async (req, res) => {
    const { scanUnitAssetNameplate } = require("../brain/shared/assetNameplateVision");
    const base64 = String(req.body && req.body.base64 ? req.body.base64 : "").trim();
    const mimeType = String(req.body && req.body.mimeType ? req.body.mimeType : "image/jpeg").trim();

    if (!base64) return res.status(400).json({ ok: false, error: "base64_required" });

    try {
      const result = await scanUnitAssetNameplate(base64, mimeType);
      return res.status(200).json({ ok: true, draft: result });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (msg.includes("api_key_missing")) {
        return res.status(503).json({ ok: false, error: "scan_not_configured" });
      }
      return res.status(500).json({ ok: false, error: msg.slice(0, 200) });
    }
  }));

  /** PM/Task V1 — propera-app Preventive tab (see docs/PM_PROGRAM_ENGINE_V1.md) */
  app.get("/api/portal/program-templates", gate(async (_req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const { data, error } = await sb
        .from("program_templates")
        .select("template_key, label, expansion_type")
        .order("template_key", { ascending: true });
      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }
      return res.status(200).json(data || []);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get("/api/portal/program-runs", gate(async (req, res) => {
    try {
      const org = portalOrgFromReq(req);
      const q = req.query || {};
      const rows = await listProgramRuns({
        orgScope: org,
        propertyCode: q.propertyCode || q.property_code,
        status: q.status,
        inProgress: q.inProgress || q.in_progress,
      });
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get(
    "/api/portal/program-runs/:programRunId/ticket-cost-entries",
    gateFinance(async (req, res) => {
      try {
        const out = await listProgramRunCostEntriesForPortal(req.params.programRunId);
        if (!out.ok) {
          const code = out.error === "program_run_not_found" ? 404 : 500;
          return res.status(code).json({ ok: false, error: out.error || "list_failed" });
        }
        return res.status(200).json({ ok: true, entries: out.entries });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.post(
    "/api/portal/program-runs/:programRunId/ticket-cost-entries",
    gateFinance(async (req, res) => {
      try {
        const out = await createProgramRunCostEntryForPortal(
          req.params.programRunId,
          req.body || {}
        );
        if (!out.ok) {
          const code =
            out.error === "program_run_not_found" || out.error === "program_line_not_found"
              ? 404
              : 400;
          return res.status(code).json({ ok: false, error: out.error || "create_failed" });
        }
        return res.status(201).json({ ok: true, entry: out.entry });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.post(
    "/api/portal/program-runs/preview",
    gate(async (req, res) => {
      try {
        const body = req.body || {};
        const out = await previewProgramRunExpansion({
          property: body.property,
          propertyCode: body.propertyCode,
          templateKey: body.templateKey,
          savedProgramId: body.savedProgramId,
          expansionType: body.expansionType,
          includedScopeLabels: Array.isArray(body.includedScopeLabels)
            ? body.includedScopeLabels
            : undefined,
        });
        if (!out.ok) {
          const code =
            out.error === "unknown_property" || out.error === "unknown_template"
              ? 400
              : 400;
          return res.status(code).json({ ok: false, error: out.error || "preview_failed" });
        }
        return res.status(200).json({
          ok: true,
          lines: out.lines,
          expansion_type: out.expansion_type,
          template_key: out.template_key,
          saved_program_id: out.saved_program_id,
          property_code: out.property_code,
        });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.get("/api/portal/program-runs/:id", gate(async (req, res) => {
    try {
      const row = await getProgramRunById(req.params.id);
      if (!row) {
        return res.status(404).json({ ok: false, error: "not_found" });
      }
      return res.status(200).json(row);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.delete("/api/portal/program-runs/:id", gate(async (req, res) => {
    try {
      const out = await deleteProgramRun(req.params.id, { traceId: req.traceId });
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "delete_failed" });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/program-runs/:programRunId/lines", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await addProgramLine(req.params.programRunId, {
        scopeType: body.scopeType || body.scope_type,
        scopeLabel: body.scopeLabel || body.scope_label,
        sortOrder: body.sortOrder ?? body.sort_order,
        actorLabel: body.actorLabel || body.actor_label || body.createdBy,
        traceId: req.traceId,
      });
      if (!out.ok) {
        const code =
          out.error === "not_found"
            ? 404
            : out.error === "invalid_scope_type" || out.error === "missing_scope_label"
              ? 400
              : 400;
        return res.status(code).json({ ok: false, error: out.error || "add_line_failed" });
      }
      return res.status(201).json({ ok: true, line: out.line, run: out.run });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.patch("/api/portal/program-runs/:programRunId/lines/reorder", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const lineIds = Array.isArray(body.lineIds)
        ? body.lineIds
        : Array.isArray(body.line_ids)
          ? body.line_ids
          : [];
      const out = await reorderProgramLines(req.params.programRunId, {
        lineIds,
        actorLabel: body.actorLabel || body.actor_label,
        traceId: req.traceId,
      });
      if (!out.ok) {
        const code =
          out.error === "not_found"
            ? 404
            : out.error === "reorder_count_mismatch" ||
                out.error === "reorder_unknown_line" ||
                out.error === "reorder_duplicate_id"
              ? 400
              : 400;
        return res.status(code).json({ ok: false, error: out.error || "reorder_failed" });
      }
      return res.status(200).json({ ok: true, run: out.run });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/program-runs", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await createProgramRun({
        property: body.property,
        propertyCode: body.propertyCode,
        templateKey: body.templateKey,
        savedProgramId: body.savedProgramId,
        createdBy: body.createdBy,
        traceId: req.traceId,
        includedScopeLabels: Array.isArray(body.includedScopeLabels) ? body.includedScopeLabels : undefined,
      });
      if (!out.ok) {
        const code =
          out.error === "unknown_property" || out.error === "unknown_template"
            ? 400
            : 400;
        return res.status(code).json({ ok: false, error: out.error || "create_failed" });
      }
      return res.status(201).json({ ok: true, run: out.run, lines: out.lines });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.patch("/api/portal/program-lines/:id/complete", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await completeProgramLine(req.params.id, {
        completedBy: body.completedBy,
        notes: body.notes,
        proofPhotoUrls: body.proofPhotoUrls,
        traceId: req.traceId,
      });
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "complete_failed" });
      }
      return res.status(200).json({ ok: true, run: out.run });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.patch("/api/portal/program-lines/:id/reopen", gate(async (req, res) => {
    try {
      const out = await reopenProgramLine(req.params.id, { traceId: req.traceId });
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "reopen_failed" });
      }
      return res.status(200).json({ ok: true, run: out.run });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.patch("/api/portal/program-lines/:id/vendor", gate(async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const hasVendorField =
        Object.prototype.hasOwnProperty.call(body, "assigned_vendor_id") ||
        Object.prototype.hasOwnProperty.call(body, "assignedVendorId");
      if (!hasVendorField) {
        return res.status(400).json({ ok: false, error: "assigned_vendor_id_required" });
      }
      const auth = String(req.get("authorization") || "").trim();
      const m = /^Bearer\s+(\S+)/i.exec(auth);
      const portalUserAccessToken = m ? m[1] : "";
      const out = await setProgramLineVendor(req.params.id, {
        assignedVendorId: Object.prototype.hasOwnProperty.call(body, "assigned_vendor_id")
          ? body.assigned_vendor_id
          : body.assignedVendorId,
        traceId: req.traceId,
        portalUserAccessToken,
      });
      if (!out.ok) {
        const code =
          out.error === "not_found"
            ? 404
            : out.error === "vendors_migration_required"
              ? 503
              : 400;
        return res.status(code).json({ ok: false, error: out.error || "vendor_assign_failed" });
      }
      return res.status(200).json({ ok: true, run: out.run });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.patch("/api/portal/program-lines/:id/staff", gate(async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const hasStaffField =
        Object.prototype.hasOwnProperty.call(body, "assigned_staff_id") ||
        Object.prototype.hasOwnProperty.call(body, "assignedStaffId");
      if (!hasStaffField) {
        return res.status(400).json({ ok: false, error: "assigned_staff_id_required" });
      }
      const auth = String(req.get("authorization") || "").trim();
      const m = /^Bearer\s+(\S+)/i.exec(auth);
      const portalUserAccessToken = m ? m[1] : "";
      const out = await setProgramLineStaff(req.params.id, {
        assignedStaffId: Object.prototype.hasOwnProperty.call(body, "assigned_staff_id")
          ? body.assigned_staff_id
          : body.assignedStaffId,
        traceId: req.traceId,
        portalUserAccessToken,
      });
      if (!out.ok) {
        const code =
          out.error === "not_found"
            ? 404
            : out.error === "staff_migration_required"
              ? 503
              : 400;
        return res.status(code).json({ ok: false, error: out.error || "staff_assign_failed" });
      }
      return res.status(200).json({ ok: true, run: out.run });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/program-lines/:id/create-ticket", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const sb = getSupabase();
      if (!sb) {
        return res.status(503).json({ ok: false, error: "no_db" });
      }
      const auth = String(req.get("authorization") || "").trim();
      const m = /^Bearer\s+(\S+)/i.exec(auth);
      const jwt = m ? m[1] : "";
      let portalTicketAudit;
      if (jwt) {
        const { resolvePortalStaffActorFromJwt } = require("../portal/resolvePortalStaffActor");
        const rAct = await resolvePortalStaffActorFromJwt(sb, jwt);
        if (!rAct.ok || !rAct.changedBy) {
          return res.status(403).json({ ok: false, error: rAct.error || "portal_actor_unresolved" });
        }
        portalTicketAudit = rAct.changedBy;
      }
      const out = await createTicketFromProgramLine({
        lineId: req.params.id,
        issueText: body.issueText ?? body.issue_text,
        category: body.category,
        urgency: body.urgency,
        actorPhoneE164: body.actor_phone_e164 ?? body.actorPhoneE164 ?? "",
        traceId: req.traceId,
        portalTicketAudit,
      });
      if (!out.ok) {
        const code =
          out.error === "not_found" || out.error === "run_not_found"
            ? 404
            : out.error === "line_already_linked"
              ? 409
              : out.error === "program_line_ticket_bridge_migration_required"
                ? 503
                : 400;
        return res.status(code).json({ ok: false, error: out.error || "create_ticket_failed" });
      }
      return res.status(201).json({
        ok: true,
        ticket_id: out.ticket_id,
        work_item_id: out.work_item_id,
        ticket_key: out.ticket_key,
        run: out.run,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.delete("/api/portal/program-lines/:id", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await deleteProgramLine(req.params.id, {
        actorLabel: body.actorLabel || body.actor_label,
        traceId: req.traceId,
      });
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "delete_line_failed" });
      }
      return res.status(200).json({ ok: true, run: out.run });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  // ── MO-2 org settings (reference/admin catalog) ─────────────────────────
  app.get("/api/portal/settings/organization", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await getOrganizationForPortal(sb, org.orgId);
      if (!out.ok) {
        const status = out.status === 404 ? 404 : 500;
        return res.status(status).json({ ok: false, error: out.error || "load_failed" });
      }
      return res.status(200).json({ ok: true, organization: out.organization });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/organization", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchOrganizationForPortal(sb, org.orgId, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, organization: out.organization });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.post("/api/portal/settings/organization/preview-sms", gateSettings(async (req, res) => {
    try {
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await previewOrgBroadcastSms(org.orgId, body);
      if (!out.ok) {
        const status = out.error === "missing_message_body" ? 400 : 500;
        return res.status(status).json({ ok: false, error: out.error || "preview_failed" });
      }
      return res.status(200).json(out);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/settings/staff", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await listStaffForOrg(sb, org.orgId);
      if (!out.ok) return res.status(500).json({ ok: false, error: out.error || "list_failed" });
      return res.status(200).json({ ok: true, staff: out.staff });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/settings/jarvis/staff", gateJarvisStaffSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await listStaffJarvisSettingsForOrg(sb, org.orgId);
      if (!out.ok) {
        const status = out.error === "migration_required" ? 503 : 500;
        return res.status(status).json({ ok: false, error: out.error || "list_failed", staff: [] });
      }
      return res.status(200).json({ ok: true, staff: out.staff });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/jarvis/staff/:staffId", gateJarvisStaffSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchStaffJarvisSettingForOrg(sb, org.orgId, req.params.staffId, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, staff: out.staff });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.post("/api/portal/settings/staff", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await createStaffForPortal(sb, org.orgId, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "create_failed" });
      }
      return res.status(201).json({ ok: true, staff: out.staff });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/staff/:staffId", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchStaffForPortal(sb, org.orgId, req.params.staffId, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, staff: out.staff });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/settings/portal-users", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await listPortalUsersForOrg(sb, org.orgId);
      if (!out.ok) return res.status(500).json({ ok: false, error: out.error || "list_failed" });
      return res.status(200).json({ ok: true, users: out.users });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.post("/api/portal/settings/portal-users", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await createPortalUserForOrg(sb, org.orgId, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "create_failed" });
      }
      return res.status(201).json({ ok: true, user: out.user });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/portal-users/:id", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchPortalUserForOrg(sb, org.orgId, req.params.id, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, user: out.user });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.delete("/api/portal/settings/portal-users/:id", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await deletePortalUserForOrg(sb, org.orgId, req.params.id);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "delete_failed" });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/settings/vendors", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const includeInactive = String(req.query.includeInactive || "").trim() === "1";
      const out = await listVendorsForOrg(sb, org.orgId, { includeInactive });
      if (!out.ok) {
        const status = out.error === "vendors_migration_required" ? 503 : 500;
        return res.status(status).json({ ok: false, error: out.error || "list_failed" });
      }
      return res.status(200).json({ ok: true, vendors: out.vendors });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/vendors/:vendorId", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchVendorForOrg(sb, org.orgId, req.params.vendorId, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, vendor: out.vendor });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/settings/properties", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const includeInactive = String(req.query.includeInactive || "").trim() === "1";
      const out = await listPropertiesForOrg(sb, org.orgId, { includeInactive });
      if (!out.ok) {
        return res.status(500).json({ ok: false, error: out.error || "list_failed" });
      }
      return res.status(200).json({ ok: true, properties: out.properties });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.post("/api/portal/settings/properties", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await createPropertyForOrg(sb, org.orgId, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "create_failed" });
      }
      return res.status(201).json({ ok: true, property: out.property });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/properties/:propertyCode", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchPropertyForOrg(sb, org.orgId, req.params.propertyCode, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, property: out.property });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/settings/staff-assignments", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await listStaffAssignmentsForOrg(sb, org.orgId);
      if (!out.ok) {
        return res.status(500).json({ ok: false, error: out.error || "list_failed" });
      }
      return res.status(200).json({ ok: true, assignments: out.assignments });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.post("/api/portal/settings/staff-assignments", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await createStaffAssignmentForOrg(sb, org.orgId, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "create_failed" });
      }
      return res.status(201).json({ ok: true, assignment: out.assignment });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/staff-assignments/:id", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchStaffAssignmentForOrg(sb, org.orgId, req.params.id, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, assignment: out.assignment });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.delete("/api/portal/settings/staff-assignments/:id", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await deleteStaffAssignmentForOrg(sb, org.orgId, req.params.id);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "delete_failed" });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/settings/team", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await getTeamSettingsBundleForOrg(sb, org.orgId);
      if (!out.ok) {
        return res.status(500).json({ ok: false, error: out.error || "load_failed" });
      }
      return res.status(200).json({ ok: true, ...out });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/team/prefs", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchOrgResponsibilityPrefs(sb, org.orgId, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, enabledRoleKeys: out.enabledRoleKeys });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/team/escalation", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchEscalationConfigForOrg(sb, org.orgId, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, escalation: out.escalation });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/team/assignment-rules", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchAssignmentRulesForOrg(sb, org.orgId, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, assignmentRules: out.rules });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.put("/api/portal/settings/team/coverage/:propertyCode", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const roles = body.roles ?? body.roleCoverage ?? body;
      const out = await savePropertyCoverageForOrg(sb, org.orgId, req.params.propertyCode, roles);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "save_failed" });
      }
      return res.status(200).json({ ok: true, propertyCode: out.propertyCode, coverage: out.coverage });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.put("/api/portal/settings/team/global-owner", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const ownerStaffId = String(body.ownerStaffId ?? body.staffId ?? "").trim();
      const out = await saveGlobalOwnerForOrg(sb, org.orgId, ownerStaffId);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "save_failed" });
      }
      return res.status(200).json({ ok: true, propertyCode: out.propertyCode, coverage: out.coverage });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.post("/api/portal/settings/team/copy-coverage", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const sourcePropertyCode = String(
        body.sourcePropertyCode ?? body.propertyCode ?? body.from ?? ""
      ).trim();
      const out = await copyPropertyCoverageToAll(sb, org.orgId, sourcePropertyCode);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "copy_failed" });
      }
      return res.status(200).json({
        ok: true,
        copiedFrom: out.copiedFrom,
        propertyCount: out.propertyCount,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/settings/channels", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await listOrgChannelsForPortal(sb, org.orgId);
      if (!out.ok) {
        const status = out.error === "missing_org_id" ? 400 : 500;
        return res.status(status).json({ ok: false, error: out.error || "load_failed" });
      }
      return res.status(200).json({
        ok: true,
        orgId: out.orgId,
        publicBaseUrl: out.publicBaseUrl,
        channels: out.channels,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/channels/:channelKey", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchOrgChannelForPortal(sb, org.orgId, req.params.channelKey, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, channel: out.channel });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/settings/policies", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const scope = String(req.query.propertyCode || req.query.scope || "GLOBAL").trim();
      const out = await listPoliciesForOrgPortal(sb, org.orgId, scope);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "load_failed" });
      }
      const propsOut = await listPropertiesForOrg(sb, org.orgId);
      const properties = propsOut.ok
        ? (propsOut.properties || []).map((p) => ({
            propertyCode: p.propertyCode,
            displayName: p.displayName,
          }))
        : [];
      return res.status(200).json({
        ok: true,
        scope: out.scope,
        groups: out.groups,
        policies: out.policies,
        properties,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/settings/policies/audit", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await listPolicyAuditForOrgPortal(sb, org.orgId, req.query.limit);
      if (!out.ok) return res.status(500).json({ ok: false, error: out.error || "audit_failed" });
      return res.status(200).json({
        ok: true,
        entries: out.entries,
        auditAvailable: out.auditAvailable !== false,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/policies/:propertyCode/:policyKey", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchPolicyForOrgPortal(
        sb,
        org.orgId,
        req.params.propertyCode,
        req.params.policyKey,
        body.value,
        { emailLower: org.emailLower }
      );
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, policy: out.policy });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.delete("/api/portal/settings/policies/:propertyCode/:policyKey", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await clearPolicyOverrideForOrgPortal(
        sb,
        org.orgId,
        req.params.propertyCode,
        req.params.policyKey,
        { emailLower: org.emailLower }
      );
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "clear_failed" });
      }
      return res.status(200).json({ ok: true, policy: out.policy });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/settings/balance-reminders", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await listBalanceRemindersForPortal(sb, org.orgId);
      if (!out.ok) {
        const status = out.error === "missing_org_id" ? 400 : out.error === "schema_missing" ? 503 : 500;
        return res.status(status).json({ ok: false, error: out.error || "load_failed" });
      }
      return res.status(200).json({
        ok: true,
        orgId: out.orgId,
        enabled: out.enabled,
        sendHour: out.sendHour,
        sendMinute: out.sendMinute,
        timezone: out.timezone,
        settingsUpdatedAt: out.settingsUpdatedAt,
        rules: out.rules,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/balance-reminders", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchBalanceReminderSettingsForPortal(sb, org.orgId, body);
      if (!out.ok) {
        const status = typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({
        ok: true,
        enabled: out.enabled,
        sendHour: out.sendHour,
        sendMinute: out.sendMinute,
        timezone: out.timezone,
        settingsUpdatedAt: out.settingsUpdatedAt,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.post("/api/portal/settings/balance-reminders/rules", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await createBalanceReminderRuleForPortal(sb, org.orgId, body);
      if (!out.ok) {
        const status = typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "create_failed" });
      }
      return res.status(201).json({ ok: true, rule: out.rule });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.post("/api/portal/settings/balance-reminders/preview-message", gateSettings(async (req, res) => {
    try {
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await previewBalanceReminderMessage(org.orgId, body);
      if (!out.ok) {
        const status = out.error === "missing_message_body" ? 400 : 500;
        return res.status(status).json({ ok: false, error: out.error || "preview_failed" });
      }
      return res.status(200).json(out);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.post("/api/portal/settings/balance-reminders/draft-message", gateSettings(async (req, res) => {
    try {
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await draftBalanceReminderMessage(org.orgId, body);
      if (!out.ok) {
        const status = out.error === "missing_brief" ? 400 : 500;
        return res.status(status).json({ ok: false, error: out.error || "draft_failed" });
      }
      return res.status(200).json(out);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.patch("/api/portal/settings/balance-reminders/:ruleKey", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await patchBalanceReminderRuleForPortal(sb, org.orgId, req.params.ruleKey, body);
      if (!out.ok) {
        const status = typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "patch_failed" });
      }
      return res.status(200).json({ ok: true, rule: out.rule });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.delete("/api/portal/settings/balance-reminders/:ruleKey", gateSettings(async (req, res) => {
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const org = portalOrgFromReq(req);
      const out = await deleteBalanceReminderRuleForPortal(sb, org.orgId, req.params.ruleKey);
      if (!out.ok) {
        const status = typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "delete_failed" });
      }
      return res.status(200).json({ ok: true, ruleKey: out.ruleKey });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }));

  app.get("/api/portal/push/vapid-public-key", gate(async (_req, res) => {
    if (!portalPushEnabled()) {
      return res.status(404).json({ ok: false, error: "portal_push_disabled" });
    }
    const publicKey = getVapidPublicKeyForClient();
    if (!publicKey) {
      return res.status(503).json({ ok: false, error: "vapid_not_configured" });
    }
    return res.status(200).json({ ok: true, publicKey });
  }));

  app.post("/api/portal/push/subscribe", gate(async (req, res) => {
    if (!portalPushEnabled()) {
      return res.status(404).json({ ok: false, error: "portal_push_disabled" });
    }
    const accessToken = String(req.get("authorization") || "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    const out = await upsertPushSubscription({
      accessToken,
      body: req.body || {},
      userAgent: req.get("user-agent") || "",
    });
    if (!out.ok) {
      const code =
        out.error === "invalid_portal_access_token" ||
        out.error === "missing_portal_access_token" ||
        out.error === "portal_user_not_allowlisted"
          ? 401
          : 400;
      return res.status(code).json({ ok: false, error: out.error || "subscribe_failed" });
    }
    return res.status(200).json({ ok: true });
  }));

  app.delete("/api/portal/push/subscribe", gate(async (req, res) => {
    if (!portalPushEnabled()) {
      return res.status(404).json({ ok: false, error: "portal_push_disabled" });
    }
    const accessToken = String(req.get("authorization") || "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    const out = await deactivatePushSubscription({
      accessToken,
      body: req.body || {},
      endpoint: req.query?.endpoint,
    });
    if (!out.ok) {
      const code =
        out.error === "invalid_portal_access_token" ||
        out.error === "missing_portal_access_token" ||
        out.error === "portal_user_not_allowlisted"
          ? 401
          : 400;
      return res.status(code).json({ ok: false, error: out.error || "unsubscribe_failed" });
    }
    return res.status(200).json({ ok: true });
  }));

  app.get("/api/portal/jarvis/pending-proposal", gate(async (req, res) => {
    return handleJarvisPendingProposal(req, res);
  }));

  const { handleJarvisDismissProposal } = require("./handleJarvisDismissProposal");
  app.post("/api/portal/jarvis/dismiss-proposal", gate(async (req, res) => {
    return handleJarvisDismissProposal(req, res);
  }));

  // ─── Financial renewals desk (status on unit_leases; no leasing UI flag) ─────

  app.patch("/api/portal/financial/renewals/:leaseId", gateSettings(async (req, res) => {
    try {
      const org = portalOrgFromReq(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const data = await patchLeaseRenewalStatus({
        leaseId: req.params.leaseId,
        renewalStatus: body.renewal_status ?? body.renewalStatus,
        renewalNotes: body.renewal_notes ?? body.renewalNotes,
        propertyCode: body.property_code || body.propertyCode || undefined,
        orgScope: org,
      });
      if (!data) {
        return res.status(404).json({ ok: false, error: "lease_not_found" });
      }
      let lifecycleSync = { ok: true, skipped: "not_vacating" };
      if (String(data.renewal_status || "").trim().toLowerCase() === "vacating") {
        lifecycleSync = await syncAfterLeaseMarkedVacating(data, { traceId: req.traceId });
      }
      return res.status(200).json({
        ok: true,
        lease: data,
        lifecycle_sync: lifecycleSync,
      });
    } catch (err) {
      const msg = String(err?.message || err);
      const code = msg.includes("org_") || msg.includes("property_code") ? 403 : 400;
      return res.status(code).json({ ok: false, error: msg });
    }
  }));

  // ─── Leasing Engine V1 ──────────────────────────────────────────────────────

  app.get("/api/portal/leasing/expiring-leases", gateLeasing(async (req, res) => {
    try {
      const org = portalOrgFromReq(req);
      const rows = await listExpiringLeasesForPortal({
        orgScope: org,
        propertyCode: req.query.propertyCode || undefined,
        renewalStatus: req.query.renewalStatus || undefined,
        days: req.query.days ? parseInt(req.query.days, 10) : 90,
      });
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }));

  app.patch("/api/portal/leasing/expiring-leases/:leaseId", gateLeasing(async (req, res) => {
    try {
      const org = portalOrgFromReq(req);
      const data = await patchLeaseRenewalStatus({
        leaseId: req.params.leaseId,
        renewalStatus: req.body?.renewal_status,
        renewalNotes: req.body?.renewal_notes,
        propertyCode: req.body?.property_code || undefined,
        orgScope: org,
      });
      if (!data) {
        return res.status(404).json({ ok: false, error: "lease_not_found" });
      }
      let lifecycleSync = { ok: true, skipped: "not_vacating" };
      if (String(data.renewal_status || "").trim().toLowerCase() === "vacating") {
        lifecycleSync = await syncAfterLeaseMarkedVacating(data, { traceId: req.traceId });
      }
      return res.status(200).json({
        ok: true,
        lease: data,
        lifecycle_sync: lifecycleSync,
      });
    } catch (err) {
      const msg = String(err?.message || err);
      const code = msg.includes("org_") || msg.includes("property_code") ? 403 : 400;
      return res.status(code).json({ ok: false, error: msg });
    }
  }));

  app.get("/api/portal/leasing/prospects", gateLeasing(async (req, res) => {
    try {
      const org = portalOrgFromReq(req);
      const rows = await listProspectsForPortal({
        orgScope: org,
        propertyCode: req.query.propertyCode || undefined,
        status: req.query.status || undefined,
        unitId: req.query.unitId || undefined,
      });
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }));

  app.post("/api/portal/leasing/prospects", gateLeasing(async (req, res) => {
    try {
      const org = portalOrgFromReq(req);
      const data = await createProspectForPortal({ orgScope: org, body: req.body || {} });
      return res.status(201).json({ ok: true, prospect: data });
    } catch (err) {
      const msg = String(err?.message || err);
      const code = msg.includes("org_") || msg.includes("property_code") || msg.includes("unit_") ? 403 : 400;
      return res.status(code).json({ ok: false, error: msg });
    }
  }));

  app.patch("/api/portal/leasing/prospects/:prospectId", gateLeasing(async (req, res) => {
    try {
      const org = portalOrgFromReq(req);
      const body = req.body || {};
      const patched = await patchProspectForPortal({
        prospectId: req.params.prospectId,
        orgScope: org,
        body,
      });
      if (!patched) {
        return res.status(404).json({ ok: false, error: "prospect_not_found" });
      }
      const { prospect, previous_status: previousStatus } = patched;
      let lifecycleSync = { ok: true, skipped: "not_signed_transition" };
      const nowSigned = String(prospect.status || "").trim().toLowerCase() === "signed";
      if (nowSigned && previousStatus !== "signed") {
        lifecycleSync = await syncAfterProspectSigned(prospect, {
          traceId: req.traceId,
          sync_lease: body.sync_lease ?? body.syncLease,
        });
      }
      return res.status(200).json({
        ok: true,
        prospect,
        lifecycle_sync: lifecycleSync,
      });
    } catch (err) {
      const msg = String(err?.message || err);
      const code = msg.includes("org_") || msg.includes("unit_") ? 403 : 400;
      return res.status(code).json({ ok: false, error: msg });
    }
  }));

  app.delete("/api/portal/leasing/prospects/:prospectId", gateLeasing(async (req, res) => {
    try {
      const org = portalOrgFromReq(req);
      const out = await deleteProspectForPortal({ prospectId: req.params.prospectId, orgScope: org });
      if (!out) {
        return res.status(404).json({ ok: false, error: "prospect_not_found" });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      const msg = String(err?.message || err);
      const code = msg.includes("org_") ? 403 : 400;
      return res.status(code).json({ ok: false, error: msg });
    }
  }));

  // ── Expense bill scan ──────────────────────────────────────────────────────
  // Accepts { base64, mimeType } JSON — propera-app converts uploaded file before proxying.
  // Provider + model selected via PROPERA_EXPENSE_SCAN_PROVIDER / PROPERA_EXPENSE_SCAN_MODEL.
  app.post("/api/portal/scan-expense", gate(async (req, res) => {
    const { scanExpenseImage } = require("../brain/shared/expenseScanVision");
    const base64 = String(req.body && req.body.base64 || "").trim();
    const mimeType = String(req.body && req.body.mimeType || "image/jpeg").trim();

    if (!base64) return res.status(400).json({ ok: false, error: "base64_required" });

    try {
      const result = await scanExpenseImage(base64, mimeType);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      emit("error", { event: "expense_scan_error", error: msg });
      if (msg.includes("api_key_missing")) {
        return res.status(503).json({ ok: false, error: "scan_not_configured" });
      }
      return res.status(500).json({ ok: false, error: msg.slice(0, 200) });
    }
  }));
}

module.exports = { registerPortalReadRoutes };
