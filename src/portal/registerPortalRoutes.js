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
} = require("../dal/programRuns");
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
const { getSupabase } = require("../db/supabase");
const { verifyPortalRequest } = require("./portalAuth");
const { turnoverEngineEnabled } = require("../config/env");

function registerPortalReadRoutes(app) {
  async function sendTickets(_req, res) {
    try {
      const rows = await listTicketsForPortal();
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  async function sendProperties(_req, res) {
    try {
      const rows = await listPropertiesForPortal();
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  async function sendTenants(_req, res) {
    try {
      const rows = await listTenantsForPortal();
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  function gate(handler) {
    return (req, res, next) => {
      if (!verifyPortalRequest(req)) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
      return handler(req, res, next);
    };
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

  /** GAS web-app style: `baseUrl?path=tickets` (propera-app remote mode). */
  app.get("/api/portal/gas-compat", gate(async (req, res) => {
    const path = String(req.query.path || "").trim().toLowerCase();
    if (path === "tickets") return sendTickets(req, res);
    if (path === "properties") return sendProperties(req, res);
    if (path === "tenants") return sendTenants(req, res);
    return res.status(400).json({ ok: false, error: "unknown_path" });
  }));

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
      return res.status(200).json({ ok: true });
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
      const out = await createTicketFromTurnoverItem({
        turnoverId: req.params.id,
        itemId: req.params.itemId,
        actorPhoneE164: body.actor_phone_e164 ?? body.actorPhoneE164 ?? "",
        traceId: req.traceId,
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
      const hint = body.ticket_id ?? body.ticketId ?? body.human_ticket_id ?? "";
      const out = await linkTicketToTurnoverItem(req.params.id, req.params.itemId, hint, {
        traceId: req.traceId,
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

  app.get("/api/portal/program-runs", gate(async (_req, res) => {
    try {
      const rows = await listProgramRuns();
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

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
}

module.exports = { registerPortalReadRoutes };
