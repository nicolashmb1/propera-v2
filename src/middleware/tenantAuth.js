/**
 * JWT guard for /api/tenant/* (except public brand + auth routes).
 */
const { verifyTenantToken } = require("../tenant/tenantJwt");
const { resolveOrgFromHost } = require("../tenant/resolveOrgFromHost");
const { enrichTenantCtx } = require("../tenant/tenantCtxEnrich");
const { getSupabase } = require("../db/supabase");

function extractBearer(req) {
  const auth = String(req.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function resolveOrgIdFromRequest(req) {
  const hdr = String(req.headers["x-propera-org-id"] || "").trim();
  if (hdr) return hdr;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  return null;
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
async function requireTenantAuth(req, res, next) {
  const token = extractBearer(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const ctx = verifyTenantToken(token);
    const sb = getSupabase();
    const host = String(
      req.headers["x-forwarded-host"] || req.headers.host || ""
    );
    const orgHdr = String(req.headers["x-propera-org-id"] || "").trim();

    let orgId = orgHdr;
    if (!orgId && sb) {
      const org = await resolveOrgFromHost(sb, host);
      orgId = org?.id || "";
    }

    if (orgId && ctx.orgId && orgId !== ctx.orgId) {
      return res.status(401).json({ ok: false, error: "org_mismatch" });
    }

    req.tenantCtx = sb ? await enrichTenantCtx(sb, ctx) : ctx;
    req.tenantOrgId = ctx.orgId || orgId;
    return next();
  } catch (_) {
    return res.status(401).json({ ok: false, error: "session_expired" });
  }
}

module.exports = { requireTenantAuth, extractBearer };
