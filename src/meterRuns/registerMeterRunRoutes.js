/**
 * Portal API — utility meter batch runs (isolated from inbound brain).
 */
const { verifyPortalRequest } = require("../portal/portalAuth");
const {
  createMeterRun,
  listMeterRuns,
  getMeterRunDetail,
  registerAsset,
  deleteMeterRunAsset,
  processPendingAssets,
  correctMeterReading,
  listUtilityMeters,
  upsertUtilityMeter,
  deactivateUtilityMeter,
  exportMeterRunCsv,
} = require("../dal/meterBillingRuns");

/**
 * @param {import("express").Express} app
 */
function registerMeterRunRoutes(app) {
  function gate(handler) {
    return (req, res, next) => {
      if (!verifyPortalRequest(req)) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
      return handler(req, res, next);
    };
  }

  app.get("/api/portal/meter-runs", gate(async (req, res) => {
    try {
      const propertyCode = req.query.propertyCode ? String(req.query.propertyCode) : "";
      const rows = await listMeterRuns({ propertyCode: propertyCode || undefined });
      return res.status(200).json({ ok: true, runs: rows });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/meter-runs", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await createMeterRun({
        propertyCode: body.propertyCode,
        periodMonth: body.periodMonth,
      });
      if (!out.ok) {
        return res.status(400).json({ ok: false, error: out.error || "create_failed" });
      }
      return res.status(201).json({ ok: true, runId: out.runId });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get("/api/portal/meter-runs/:id/export", gate(async (req, res) => {
    try {
      const csv = await exportMeterRunCsv(req.params.id);
      if (csv == null) {
        return res.status(404).type("text/plain").send("not_found");
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="meter-run-${req.params.id}.csv"`);
      return res.status(200).send(csv);
    } catch (err) {
      return res.status(500).type("text/plain").send(String(err && err.message ? err.message : err));
    }
  }));

  app.get("/api/portal/meter-runs/:id", gate(async (req, res) => {
    try {
      const detail = await getMeterRunDetail(req.params.id);
      if (!detail) {
        return res.status(404).json({ ok: false, error: "not_found" });
      }
      return res.status(200).json({ ok: true, ...detail });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/meter-runs/:id/assets", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await registerAsset({
        runId: req.params.id,
        storagePath: body.storagePath,
        mimeType: body.mimeType,
        storageBucket: body.storageBucket,
      });
      if (!out.ok) {
        const code = out.error === "run_not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "asset_failed" });
      }
      return res.status(201).json({ ok: true, assetId: out.assetId });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.delete("/api/portal/meter-runs/:id/assets/:assetId", gate(async (req, res) => {
    try {
      const out = await deleteMeterRunAsset({
        runId: req.params.id,
        assetId: req.params.assetId,
      });
      if (!out.ok) {
        const code = out.error === "asset_not_found" ? 404 : 400;
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

  app.post("/api/portal/meter-runs/:id/process", gate(async (req, res) => {
    try {
      const out = await processPendingAssets(req.params.id, {});
      if (!out.ok) {
        return res.status(400).json({ ok: false, error: out.error || "process_failed" });
      }
      const detail = await getMeterRunDetail(req.params.id);
      const failures = Array.isArray(out.results)
        ? out.results.filter((r) => r && r.ok === false && r.error)
        : [];
      const process_errors = failures.map((r) => String(r.error)).filter(Boolean);
      return res.status(200).json({
        ok: true,
        processed: out.processed,
        detail,
        ...(process_errors.length ? { process_errors } : {}),
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.patch("/api/portal/meter-readings/:id", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await correctMeterReading({
        readingId: req.params.id,
        currentReading: body.currentReading,
        correctedBy: body.correctedBy,
      });
      if (!out.ok) {
        const code = out.error === "not_found" ? 404 : 400;
        return res.status(code).json({ ok: false, error: out.error || "correct_failed" });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.get("/api/portal/utility-meters", gate(async (req, res) => {
    try {
      const propertyCode = String(req.query.propertyCode || "").trim();
      const rows = await listUtilityMeters(propertyCode);
      return res.status(200).json({ ok: true, meters: rows });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }));

  app.post("/api/portal/utility-meters", gate(async (req, res) => {
    try {
      const body = req.body || {};
      const out = await upsertUtilityMeter(body);
      if (!out.ok) {
        const code = out.error === "unknown_property_code" ? 422 : 400;
        return res.status(code).json({
          ok: false,
          error: out.error || "upsert_failed",
          ...(typeof out.hint === "string" && out.hint ? { hint: out.hint } : {}),
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

  app.delete("/api/portal/utility-meters/:id", gate(async (req, res) => {
    try {
      const propertyCode = req.query.propertyCode ? String(req.query.propertyCode) : "";
      const out = await deactivateUtilityMeter({
        meterId: req.params.id,
        propertyCode: propertyCode.trim() || undefined,
      });
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
}

module.exports = { registerMeterRunRoutes };
