/**
 * Resolve active organization for portal HTTP requests (MO-1).
 * JWT allowlist → optional header → default org env fallback.
 */
const { portalApiToken, defaultOrgId } = require("../config/env");
const { normOrgId, loadOrgPropertyScope } = require("./portalOrgScope");

/**
 * @param {import("express").Request} req
 * @returns {string}
 */
function extractPortalUserJwt(req) {
  const portalTok = portalApiToken();
  const auth = String(req.get("authorization") || "").trim();
  if (auth.match(/^Bearer\s+/i)) {
    const tok = auth.replace(/^Bearer\s+/i, "").trim();
    if (portalTok && tok === portalTok) return "";
    if (tok.split(".").length === 3) return tok;
  }
  const hdr = String(req.get("x-propera-portal-jwt") || "").trim();
  if (hdr.split(".").length === 3) return hdr;
  return "";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} accessToken
 */
async function resolveAllowlistFromJwt(sb, accessToken) {
  const tok = String(accessToken || "").trim();
  if (!tok || !sb) return { ok: false, error: "missing_token" };

  const { data: userData, error: authErr } = await sb.auth.getUser(tok);
  if (authErr || !userData || !userData.user) {
    return { ok: false, error: "invalid_portal_access_token" };
  }

  const user = userData.user;
  const uid = String(user.id || "").trim();
  const emailLower = user.email ? String(user.email).trim().toLowerCase() : "";

  let allow = null;
  if (uid) {
    const { data: byUid } = await sb
      .from("portal_auth_allowlist")
      .select("org_id, staff_id, portal_role, active, email_lower, auth_user_id")
      .eq("auth_user_id", uid)
      .eq("active", true)
      .maybeSingle();
    if (byUid) allow = byUid;
  }
  if (!allow && emailLower) {
    const { data: byEmail } = await sb
      .from("portal_auth_allowlist")
      .select("org_id, staff_id, portal_role, active, email_lower, auth_user_id")
      .eq("email_lower", emailLower)
      .eq("active", true)
      .maybeSingle();
    if (byEmail) allow = byEmail;
  }

  if (!allow) return { ok: false, error: "portal_user_not_allowlisted" };

  const orgId = normOrgId(allow.org_id) || normOrgId(defaultOrgId());
  return {
    ok: true,
    orgId,
    portalRole: String(allow.portal_role || "").trim(),
    staffId: String(allow.staff_id || "").trim(),
    emailLower,
    source: "jwt",
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} orgId
 * @param {string} source
 */
async function buildOrgContext(sb, orgId, source) {
  const oid = normOrgId(orgId) || normOrgId(defaultOrgId());
  const scope = await loadOrgPropertyScope(sb, oid);

  let brandName = "";
  let brandShortName = "";
  if (sb && oid) {
    const { data: orgRow } = await sb
      .from("organizations")
      .select("brand_name, brand_short_name")
      .eq("id", oid)
      .maybeSingle();
    if (orgRow) {
      brandName = String(orgRow.brand_name || "").trim();
      brandShortName = String(orgRow.brand_short_name || "").trim();
    }
  }

  return {
    ok: true,
    orgId: oid,
    orgBrandName: brandName,
    orgBrandShortName: brandShortName,
    propertyCodes: scope.propertyCodes,
    propertyCodesUpper: scope.propertyCodesUpper,
    source: source || "default",
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {import("express").Request} req
 */
async function resolvePortalOrgContext(sb, req) {
  const jwt = extractPortalUserJwt(req);
  if (jwt) {
    const allow = await resolveAllowlistFromJwt(sb, jwt);
    if (allow.ok) {
      const ctx = await buildOrgContext(sb, allow.orgId, "jwt");
      return {
        ...ctx,
        portalRole: allow.portalRole,
        staffId: allow.staffId,
        emailLower: allow.emailLower,
      };
    }
  }

  const hdrOrg = normOrgId(req.get("x-propera-org-id"));
  if (hdrOrg) {
    return buildOrgContext(sb, hdrOrg, "header");
  }

  return buildOrgContext(sb, defaultOrgId(), "default");
}

/**
 * Attach org context to Express request for portal handlers.
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 */
function attachPortalOrgContextMiddleware(sb) {
  return async (req, res, next) => {
    try {
      req.portalOrg = await resolvePortalOrgContext(sb, req);
      return next();
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  };
}

module.exports = {
  extractPortalUserJwt,
  resolveAllowlistFromJwt,
  resolvePortalOrgContext,
  attachPortalOrgContextMiddleware,
  buildOrgContext,
};
