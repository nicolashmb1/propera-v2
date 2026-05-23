/**
 * Resident portal HTTP API — /api/tenant/*
 * @see docs/TENANT_PORTAL_BUILD_PLAN.md
 */
const { getSupabase, isDbConfigured } = require("../db/supabase");
const { tenantJwtSecret } = require("../config/env");
const { resolveOrgFromHost } = require("./resolveOrgFromHost");
const { loadOrgBrandById } = require("./tenantBrandResolve");
const {
  requestOtp,
  verifyOtp,
  identifyTenantByUnitAndPhone,
  loadTenantSessionBrand,
} = require("./authService");
const { requireTenantAuth } = require("../middleware/tenantAuth");
const {
  listTenantTickets,
  getTenantTicket,
  createTenantMaintenanceTicket,
  getMaintenanceUploadUrl,
} = require("./tenantMaintenanceService");
const { accessEngineEnabled } = require("../config/env");
const {
  listTenantAccessLocations,
  getPublicAccessLocation,
  getTenantAccessLocationBySlug,
  listTenantAccessReservations,
  getTenantAccessReservation,
  checkTenantCanReserve,
  createTenantAccessReservation,
  cancelTenantAccessReservation,
  listDayReservationsForTenantLocation,
} = require("./tenantAccessService");

function orgFromRequest(req) {
  const hdr = String(req.headers["x-propera-org-id"] || "").trim();
  if (hdr) return hdr;
  return null;
}

async function resolveOrgForRequest(req) {
  const sb = getSupabase();
  if (!sb) return null;
  const existing = orgFromRequest(req);
  if (existing) {
    const brand = await loadOrgBrandById(sb, existing);
    return brand ? { id: existing, ...brand } : null;
  }
  const host = String(
    req.headers["x-forwarded-host"] || req.headers.host || ""
  );
  const org = await resolveOrgFromHost(sb, host);
  if (!org) return null;
  return { id: org.id, ...org };
}

/**
 * @param {import("express").Express} app
 */
function registerTenantRoutes(app) {
  app.get("/api/tenant/brand", async (req, res) => {
    if (!isDbConfigured()) {
      return res.status(503).json({ ok: false, error: "no_db" });
    }
    const hostQ = String(req.query.host || "").trim();
    const host = hostQ || String(req.headers.host || "");
    const sb = getSupabase();
    const org = await resolveOrgFromHost(sb, host);
    if (!org) {
      return res.status(404).json({ ok: false, error: "org_not_found" });
    }
    const brand = await loadOrgBrandById(sb, org.id);
    if (!brand) {
      return res.status(404).json({ ok: false, error: "org_not_found" });
    }
    return res.json({
      ok: true,
      orgBrandName: brand.orgBrandName,
      orgBrandShort: brand.orgBrandShort,
      propertyDisplayName: brand.propertyDisplayName,
      propertyDisplayNameShort: brand.propertyDisplayNameShort,
      showProperaAttribution: brand.showProperaAttribution,
      mainNumberE164: brand.mainNumberE164,
    });
  });

  app.post("/api/tenant/auth/request-otp", async (req, res) => {
    if (!tenantJwtSecret()) {
      return res.status(503).json({ ok: false, error: "tenant_auth_not_configured" });
    }
    if (!isDbConfigured()) {
      return res.status(503).json({ ok: false, error: "no_db" });
    }

    const orgCtx = await resolveOrgForRequest(req);
    if (!orgCtx?.id) {
      return res.status(404).json({ ok: false, error: "org_not_found" });
    }

    const phone = req.body?.phone;
    try {
      const out = await requestOtp(phone, orgCtx.id, req.traceId);
      return res.json({ ok: true, ...out });
    } catch (err) {
      const code = err.code || "request_failed";
      if (code === "TENANT_NOT_FOUND") {
        return res.status(404).json({ ok: false, error: "not_found" });
      }
      if (code === "PORTAL_ACCESS_DENIED") {
        return res.status(403).json({ ok: false, error: "access_denied" });
      }
      if (code === "RATE_LIMITED") {
        return res.status(429).json({ ok: false, error: "rate_limited" });
      }
      return res.status(400).json({ ok: false, error: code });
    }
  });

  app.post("/api/tenant/auth/verify-otp", async (req, res) => {
    if (!tenantJwtSecret()) {
      return res.status(503).json({ ok: false, error: "tenant_auth_not_configured" });
    }
    if (!isDbConfigured()) {
      return res.status(503).json({ ok: false, error: "no_db" });
    }

    const orgCtx = await resolveOrgForRequest(req);
    if (!orgCtx?.id) {
      return res.status(404).json({ ok: false, error: "org_not_found" });
    }

    const phone = req.body?.phone;
    const code = req.body?.code;
    try {
      const out = await verifyOtp(phone, code, orgCtx.id);
      return res.json({ ok: true, ...out });
    } catch (err) {
      const c = err.code || "verify_failed";
      if (c === "TENANT_NOT_FOUND") {
        return res.status(404).json({ ok: false, error: "not_found" });
      }
      if (c === "OTP_MAX_ATTEMPTS") {
        return res.status(429).json({ ok: false, error: "max_attempts" });
      }
      if (c === "OTP_EXPIRED" || c === "OTP_INVALID") {
        return res.status(400).json({ ok: false, error: c === "OTP_EXPIRED" ? "expired" : "invalid" });
      }
      return res.status(400).json({ ok: false, error: "invalid" });
    }
  });

  app.post("/api/tenant/auth/logout", (_req, res) => {
    return res.json({ ok: true, success: true });
  });

  /** QR door flow — unit + phone, no SMS OTP (campaign not approved). */
  app.post("/api/tenant/auth/identify", async (req, res) => {
    if (!tenantJwtSecret()) {
      return res.status(503).json({ ok: false, error: "tenant_auth_not_configured" });
    }
    if (!isDbConfigured()) {
      return res.status(503).json({ ok: false, error: "no_db" });
    }

    const orgCtx = await resolveOrgForRequest(req);
    if (!orgCtx?.id) {
      return res.status(404).json({ ok: false, error: "org_not_found" });
    }

    const body = req.body || {};
    try {
      const out = await identifyTenantByUnitAndPhone(
        body.phone,
        body.unitLabel || body.unit_label,
        body.propertyCode || body.property_code,
        orgCtx.id
      );
      return res.json({ ok: true, ...out });
    } catch (err) {
      const c = err.code || "identify_failed";
      if (c === "TENANT_NOT_FOUND" || c === "PROPERTY_NOT_FOUND") {
        return res.status(404).json({ ok: false, error: "not_found" });
      }
      if (c === "PORTAL_ACCESS_DENIED") {
        return res.status(403).json({ ok: false, error: "access_denied" });
      }
      if (c === "RATE_LIMITED") {
        return res.status(429).json({ ok: false, error: "rate_limited" });
      }
      if (c === "INVALID_PHONE" || c === "VALIDATION_ERROR") {
        return res.status(400).json({ ok: false, error: "invalid" });
      }
      return res.status(400).json({ ok: false, error: c });
    }
  });

  app.get("/api/tenant/me", requireTenantAuth, async (req, res) => {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ ok: false, error: "no_db" });

    const session = await loadTenantSessionBrand(
      sb,
      req.tenantCtx.tenantId,
      req.tenantCtx.orgId
    );
    if (!session) {
      return res.status(401).json({ ok: false, error: "session_invalid" });
    }
    return res.json({ ok: true, ...session });
  });

  // ── Maintenance ──────────────────────────────────────────────────────────

  app.get("/api/tenant/maintenance", requireTenantAuth, async (req, res) => {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
    try {
      const tickets = await listTenantTickets(sb, req.tenantCtx, {
        status: String(req.query.status || "all"),
        limit:  Number(req.query.limit  || 20),
        offset: Number(req.query.offset || 0),
      });
      return res.json({ ok: true, tickets });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.get("/api/tenant/maintenance/upload-url", requireTenantAuth, async (req, res) => {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
    const fileName = String(req.query.fileName || "photo.jpg").trim();
    try {
      const result = await getMaintenanceUploadUrl(sb, req.tenantCtx, fileName);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.get("/api/tenant/maintenance/:ticketId", requireTenantAuth, async (req, res) => {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ ok: false, error: "no_db" });
    try {
      const ticket = await getTenantTicket(sb, req.tenantCtx, req.params.ticketId);
      if (!ticket) return res.status(404).json({ ok: false, error: "not_found" });
      return res.json({ ok: true, ticket });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.post("/api/tenant/maintenance", requireTenantAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await createTenantMaintenanceTicket(
        req.tenantCtx,
        {
          category:    body.category,
          description: body.description,
          photoUrls:   body.photoUrls,
        },
        req.traceId
      );
      return res.status(201).json({ ok: true, ...result });
    } catch (err) {
      if (err.code === "VALIDATION_ERROR" || err.code === "SESSION_ERROR") {
        return res.status(400).json({ ok: false, error: err.message });
      }
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  // ── Amenity / Access reservations (building-scoped) ─────────────────────────

  app.get(
    "/api/tenant/access/public/:propertyCode/:slug",
    async (req, res) => {
      const off = accessDisabled(res);
      if (off) return off;
      const orgCtx = await resolveOrgForRequest(req);
      if (!orgCtx?.id) {
        return res.status(404).json({ ok: false, error: "org_not_found" });
      }
      try {
        const location = await getPublicAccessLocation(
          orgCtx.id,
          req.params.propertyCode,
          req.params.slug
        );
        if (!location) {
          return res.status(404).json({ ok: false, error: "not_found" });
        }
        return res.json({
          ok: true,
          location,
          brand: {
            orgBrandShort: orgCtx.orgBrandShort || "",
            propertyDisplayName: orgCtx.propertyDisplayName || "",
          },
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    }
  );

  function accessDisabled(res) {
    if (!accessEngineEnabled()) {
      return res.status(404).json({ ok: false, error: "access_engine_disabled" });
    }
    return null;
  }

  app.get("/api/tenant/access/locations", requireTenantAuth, async (req, res) => {
    const off = accessDisabled(res);
    if (off) return off;
    try {
      const locations = await listTenantAccessLocations(req.tenantCtx);
      return res.json({ ok: true, locations });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.get("/api/tenant/access/locations/:slug", requireTenantAuth, async (req, res) => {
    const off = accessDisabled(res);
    if (off) return off;
    try {
      const location = await getTenantAccessLocationBySlug(
        req.tenantCtx,
        req.params.slug
      );
      if (!location) return res.status(404).json({ ok: false, error: "not_found" });
      return res.json({ ok: true, location });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.get(
    "/api/tenant/access/locations/:slug/availability",
    requireTenantAuth,
    async (req, res) => {
      const off = accessDisabled(res);
      if (off) return off;
      try {
        const location = await getTenantAccessLocationBySlug(
          req.tenantCtx,
          req.params.slug
        );
        if (!location) {
          return res.status(404).json({ ok: false, error: "not_found" });
        }
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        const bookings = await listDayReservationsForTenantLocation(
          req.tenantCtx,
          location.id,
          date
        );
        const startAt = req.query.startAt || req.query.start_at;
        const endAt = req.query.endAt || req.query.end_at;
        let check = null;
        if (startAt && endAt) {
          check = await checkTenantCanReserve(
            req.tenantCtx,
            location.id,
            startAt,
            endAt
          );
        }
        return res.json({ ok: true, location, bookings, check });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    }
  );

  app.get("/api/tenant/access/reservations", requireTenantAuth, async (req, res) => {
    const off = accessDisabled(res);
    if (off) return off;
    try {
      const reservations = await listTenantAccessReservations(req.tenantCtx);
      return res.json({ ok: true, reservations });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.get("/api/tenant/access/reservations/:id", requireTenantAuth, async (req, res) => {
    const off = accessDisabled(res);
    if (off) return off;
    try {
      const reservation = await getTenantAccessReservation(
        req.tenantCtx,
        req.params.id
      );
      if (!reservation) return res.status(404).json({ ok: false, error: "not_found" });
      return res.json({ ok: true, reservation });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.post("/api/tenant/access/reservations", requireTenantAuth, async (req, res) => {
    const off = accessDisabled(res);
    if (off) return off;
    try {
      const body = req.body || {};
      const reservation = await createTenantAccessReservation(req.tenantCtx, {
        locationId: body.locationId || body.location_id,
        startAt: body.startAt || body.start_at,
        endAt: body.endAt || body.end_at,
        channel: body.channel,
      });
      return res.status(201).json({ ok: true, reservation });
    } catch (err) {
      const code = err.code || String(err.message || "failed");
      const status =
        code === "location_not_found" || code === "not_allowed" || code.includes("duration")
          ? 400
          : 500;
      return res.status(status).json({ ok: false, error: code });
    }
  });

  app.post(
    "/api/tenant/access/reservations/:id/cancel",
    requireTenantAuth,
    async (req, res) => {
      const off = accessDisabled(res);
      if (off) return off;
      try {
        const reservation = await cancelTenantAccessReservation(
          req.tenantCtx,
          req.params.id
        );
        return res.json({ ok: true, reservation });
      } catch (err) {
        const code = err.code || "failed";
        const status = code === "not_found" ? 404 : 400;
        return res.status(status).json({ ok: false, error: code });
      }
    }
  );
}

module.exports = { registerTenantRoutes };
