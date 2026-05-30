/**
 * MO-4 public org signup — gated by env + shared secret (no portal JWT).
 */
const { getSupabase } = require("../db/supabase");
const { orgSignupEnabled, orgSignupSecret } = require("../config/env");
const {
  checkOrgBootstrapAvailability,
  bootstrapOrganization,
} = require("../dal/portalOrgOnboarding");

function verifyOrgSignupRequest(req, res) {
  if (!orgSignupEnabled()) {
    res.status(404).json({ ok: false, error: "org_signup_disabled" });
    return false;
  }
  const secret = orgSignupSecret();
  if (!secret) {
    res.status(503).json({ ok: false, error: "org_signup_not_configured" });
    return false;
  }
  const hdr = String(req.get("x-propera-org-signup-secret") || "").trim();
  if (hdr !== secret) {
    res.status(401).json({ ok: false, error: "org_signup_unauthorized" });
    return false;
  }
  return true;
}

function registerOnboardingRoutes(app) {
  app.get("/api/onboarding/signup-config", (_req, res) => {
    return res.status(200).json({
      ok: true,
      enabled: orgSignupEnabled() && !!orgSignupSecret(),
    });
  });

  app.post("/api/onboarding/check-availability", async (req, res) => {
    if (!verifyOrgSignupRequest(req, res)) return;
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await checkOrgBootstrapAvailability(sb, body);
      if (!out.ok) {
        const status = typeof out.status === "number" && out.status >= 400 ? out.status : 400;
        return res.status(status).json({ ok: false, error: out.error || "check_failed" });
      }
      return res.status(200).json(out);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  app.post("/api/onboarding/bootstrap", async (req, res) => {
    if (!verifyOrgSignupRequest(req, res)) return;
    try {
      const sb = getSupabase();
      if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const out = await bootstrapOrganization(sb, body);
      if (!out.ok) {
        const status =
          typeof out.status === "number" && out.status >= 400 ? out.status : 500;
        return res.status(status).json({ ok: false, error: out.error || "bootstrap_failed" });
      }
      return res.status(201).json(out);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
}

module.exports = { registerOnboardingRoutes };
