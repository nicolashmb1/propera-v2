/**
 * Conflict Mediation Engine — CME-1 read + CME-2 write portal API.
 * @see docs/CONFLICT_MEDIATION_ENGINE.md
 */
const { verifyPortalRequest } = require("../portal/portalAuth");
const { isDbConfigured } = require("../db/supabase");
const { conflictMediationEngineEnabled } = require("../config/env");
const {
  listConflictCasesForPortal,
  getConflictCaseDetailForPortal,
  listConflictPoliciesForPortal,
} = require("./conflictCaseRead");
const {
  reportPolicyViolation,
  issuePolicyNotice,
  previewPolicyNotice,
} = require("./conflictCaseWrite");

function registerConflictMediationRoutes(app) {
  function gate(handler) {
    return async (req, res, next) => {
      if (!verifyPortalRequest(req)) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
      if (!conflictMediationEngineEnabled()) {
        return res.status(404).json({ ok: false, error: "conflict_mediation_disabled" });
      }
      if (!isDbConfigured()) {
        return res.status(503).json({ ok: false, error: "no_db" });
      }
      return handler(req, res, next);
    };
  }

  app.get(
    "/api/conflict/cases",
    gate(async (req, res) => {
      try {
        const out = await listConflictCasesForPortal({
          propertyCode: req.query.propertyCode || req.query.property_code,
          state: req.query.state,
          limit: req.query.limit,
          offset: req.query.offset,
        });
        if (!out.ok) {
          const status = out.error === "no_db" ? 503 : 400;
          return res.status(status).json({ ok: false, error: out.error || "list_failed" });
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

  app.post(
    "/api/conflict/cases",
    gate(async (req, res) => {
      try {
        const out = await reportPolicyViolation(req.body || {}, { traceId: req.traceId });
        if (!out.ok) {
          const status =
            out.error === "policy_not_found" || out.error === "policy_property_mismatch"
              ? 404
              : 400;
          return res.status(status).json({ ok: false, error: out.error || "report_failed" });
        }
        return res.status(201).json(out);
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    })
  );

  app.get(
    "/api/conflict/cases/:id",
    gate(async (req, res) => {
      try {
        const out = await getConflictCaseDetailForPortal(req.params.id);
        if (!out.ok) {
          const status =
            out.error === "not_found" ? 404 : out.error === "no_db" ? 503 : 400;
          return res.status(status).json({ ok: false, error: out.error || "detail_failed" });
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

  app.get(
    "/api/conflict/cases/:id/notice-preview",
    gate(async (req, res) => {
      try {
        const out = await previewPolicyNotice(req.params.id);
        if (!out.ok) {
          const status =
            out.error === "not_found" ? 404 : out.error === "no_db" ? 503 : 400;
          return res.status(status).json({ ok: false, error: out.error || "preview_failed" });
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

  app.post(
    "/api/conflict/cases/:id/issue-notice",
    gate(async (req, res) => {
      try {
        const out = await issuePolicyNotice(req.params.id, req.body || {}, {
          traceId: req.traceId,
        });
        if (!out.ok) {
          const status =
            out.error === "not_found"
              ? 404
              : out.error === "twilio_outbound_disabled" || out.error === "notice_send_failed"
                ? 502
                : 400;
          return res.status(status).json({ ok: false, error: out.error || "issue_notice_failed", ...out });
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

  app.get(
    "/api/conflict/policies",
    gate(async (req, res) => {
      try {
        const out = await listConflictPoliciesForPortal({
          propertyCode: req.query.propertyCode || req.query.property_code,
        });
        if (!out.ok) {
          const status = out.error === "no_db" ? 503 : 400;
          return res.status(status).json({ ok: false, error: out.error || "list_failed" });
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
}

module.exports = { registerConflictMediationRoutes };
