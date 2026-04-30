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
  listProgramRuns,
  getProgramRunById,
  completeProgramLine,
  reopenProgramLine,
} = require("../dal/programRuns");
const { getSupabase } = require("../db/supabase");
const { verifyPortalRequest } = require("./portalAuth");

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

  /** GAS web-app style: `baseUrl?path=tickets` (propera-app remote mode). */
  app.get("/api/portal/gas-compat", gate(async (req, res) => {
    const path = String(req.query.path || "").trim().toLowerCase();
    if (path === "tickets") return sendTickets(req, res);
    if (path === "properties") return sendProperties(req, res);
    if (path === "tenants") return sendTenants(req, res);
    return res.status(400).json({ ok: false, error: "unknown_path" });
  }));

  app.get("/api/portal/tickets", gate(sendTickets));
  app.get("/api/portal/properties", gate(sendProperties));
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

  app.post("/api/portal/program-runs", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await createProgramRun({
        property: body.property,
        propertyCode: body.propertyCode,
        templateKey: body.templateKey,
        createdBy: body.createdBy,
        traceId: req.traceId,
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
