const { verifyPortalRequest } = require("../portal/portalAuth");
const { isDbConfigured } = require("../db/supabase");
const { communicationEngineEnabled } = require("../config/env");
const {
  createCampaign,
  listCampaigns,
  getCampaignDetail,
  deleteCampaign,
  updateCampaignDraft,
  resolveCampaignAudiencePreview,
  previewCampaignMessage,
  sendCampaignNow,
} = require("./campaignService");

function registerCommunicationRoutes(app) {
  function gate(handler) {
    return async (req, res, next) => {
      if (!verifyPortalRequest(req)) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
      if (!communicationEngineEnabled()) {
        return res.status(404).json({ ok: false, error: "communication_engine_disabled" });
      }
      if (!isDbConfigured()) {
        return res.status(503).json({ ok: false, error: "no_db" });
      }
      return handler(req, res, next);
    };
  }

  app.get(
    "/api/communications/campaigns",
    gate(async (req, res) => {
      try {
        const out = await listCampaigns({
          status: req.query.status,
          limit: req.query.limit,
          offset: req.query.offset,
          orgId: req.query.orgId || req.query.org_id,
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
    "/api/communications/campaigns",
    gate(async (req, res) => {
      try {
        const out = await createCampaign(req.body || {}, { traceId: req.traceId });
        if (!out.ok) {
          return res.status(400).json({ ok: false, error: out.error || "create_failed" });
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
    "/api/communications/campaigns/:id",
    gate(async (req, res) => {
      try {
        const out = await getCampaignDetail(req.params.id);
        if (!out.ok) {
          const status = out.error === "not_found" ? 404 : out.error === "no_db" ? 503 : 400;
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

  app.delete(
    "/api/communications/campaigns/:id",
    gate(async (req, res) => {
      try {
        const out = await deleteCampaign(req.params.id, { traceId: req.traceId });
        if (!out.ok) {
          const status =
            out.error === "not_found" ? 404 :
            out.error === "no_db" ? 503 :
            out.error === "campaign_not_deletable" ? 409 :
            400;
          return res.status(status).json({ ok: false, error: out.error || "delete_failed" });
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
    "/api/communications/draft",
    gate(async (req, res) => {
      try {
        const out = await updateCampaignDraft(req.body || {}, { traceId: req.traceId });
        if (!out.ok) {
          const status =
            out.error === "not_found" ? 404 :
            out.error === "no_db" ? 503 :
            out.error === "campaign_not_draft" ? 409 :
            400;
          return res.status(status).json({ ok: false, error: out.error || "draft_failed" });
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
    "/api/communications/campaigns/:id/preview",
    gate(async (req, res) => {
      try {
        const out = await previewCampaignMessage(req.params.id, req.body || {});
        if (!out.ok) {
          const status =
            out.error === "not_found" ? 404 :
            out.error === "no_db" ? 503 :
            400;
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
    "/api/communications/campaigns/:id/resolve",
    gate(async (req, res) => {
      try {
        const out = await resolveCampaignAudiencePreview(req.params.id, {
          traceId: req.traceId,
        });
        if (!out.ok) {
          const status = out.error === "not_found" ? 404 : out.error === "no_db" ? 503 : 400;
          return res.status(status).json({ ok: false, error: out.error || "resolve_failed" });
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
    "/api/communications/campaigns/:id/send",
    gate(async (req, res) => {
      try {
        const out = await sendCampaignNow(req.params.id, { traceId: req.traceId });
        if (!out.ok) {
          const status =
            out.error === "not_found" ? 404 :
            out.error === "no_db" ? 503 :
            out.error === "campaign_not_sendable" || out.error === "campaign_not_preparable" ? 409 :
            400;
          return res.status(status).json({ ok: false, error: out.error || "send_failed" });
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

module.exports = { registerCommunicationRoutes };
