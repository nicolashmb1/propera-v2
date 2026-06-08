/**
 * Access Engine portal API — staff cockpit (propera-app proxies).
 * @see docs/ACCESS_ENGINE_BUILD_PLAN.md
 */
const { verifyPortalRequest } = require("./portalAuth");
const { accessEngineEnabled } = require("../config/env");
const {
  listAccessLocationsForPortal,
  updateAccessLocationForPortal,
  getAccessLocationById,
  getAccessPolicyForLocation,
  listSchedulesForLocation,
  listBlackoutsForLocation,
  listReservationsForLocation,
  getLocationStats,
  createAccessLocationForPortal,
  upsertAccessPolicyForLocation,
  replaceSchedulesForLocation,
  createBlackoutForLocation,
  deleteBlackout,
  getReservationDetail,
  createReservationForPortal,
  approveReservation,
  cancelReservation,
  regeneratePin,
  patchReservationTimes,
  listAccessProgramForProperty,
  setAccessProgramEnrollment,
} = require("../dal/accessEngine");

function registerAccessRoutes(app) {
  function gate(handler) {
    return (req, res, next) => {
      if (!verifyPortalRequest(req)) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
      return handler(req, res, next);
    };
  }

  function gateAccess(handler) {
    return gate(async (req, res, next) => {
      if (!accessEngineEnabled()) {
        return res.status(404).json({ ok: false, error: "access_engine_disabled" });
      }
      return handler(req, res, next);
    });
  }

  function actorFromReq(req) {
    return String(req.body?.actor || req.query?.actor || "portal_staff").trim();
  }

  app.get(
    "/api/portal/access/properties/:propertyCode/program",
    gateAccess(async (req, res) => {
      try {
        const code = String(req.params.propertyCode || "").trim();
        const out = await listAccessProgramForProperty(code);
        return res.json({ ok: true, ...out });
      } catch (err) {
        const msg = String(err.message || err);
        const status =
          msg === "invalid_property_code" || msg === "property_location_not_found"
            ? 400
            : 500;
        return res.status(status).json({ ok: false, error: msg });
      }
    })
  );

  app.put(
    "/api/portal/access/properties/:propertyCode/program",
    gateAccess(async (req, res) => {
      try {
        const code = String(req.params.propertyCode || "").trim();
        const propertyLocationId = String(
          req.body?.propertyLocationId || req.body?.property_location_id || ""
        ).trim();
        const out = await setAccessProgramEnrollment({
          propertyCode: code,
          propertyLocationId,
          enabled: req.body?.enabled,
          enrolled: req.body?.enrolled,
          staffOnly: req.body?.staffOnly,
          internalOnly: req.body?.internalOnly,
          staff_only: req.body?.staff_only,
          internal_only: req.body?.internal_only,
          actor: actorFromReq(req),
        });
        return res.json({ ok: true, ...out });
      } catch (err) {
        const msg = String(err.message || err);
        const status =
          msg === "invalid_property_code" ||
          msg === "missing_fields" ||
          msg === "property_location_not_found" ||
          msg === "not_common_area"
            ? 400
            : 500;
        return res.status(status).json({ ok: false, error: msg });
      }
    })
  );

  app.get(
    "/api/portal/access/locations",
    gateAccess(async (req, res) => {
      try {
        const rows = await listAccessLocationsForPortal({
          orgId: req.query.orgId,
          propertyCode: req.query.propertyCode,
          activeOnly: req.query.includeInactive !== "1",
        });
        return res.json({ ok: true, locations: rows });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.post(
    "/api/portal/access/locations",
    gateAccess(async (req, res) => {
      try {
        const loc = await createAccessLocationForPortal(req.body || {}, actorFromReq(req));
        return res.status(201).json({ ok: true, location: loc });
      } catch (err) {
        return res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.get(
    "/api/portal/access/locations/:locationId",
    gateAccess(async (req, res) => {
      try {
        const loc = await getAccessLocationById(req.params.locationId);
        if (!loc) return res.status(404).json({ ok: false, error: "not_found" });
        return res.json({ ok: true, location: loc });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.put(
    "/api/portal/access/locations/:locationId",
    gateAccess(async (req, res) => {
      try {
        const loc = await updateAccessLocationForPortal(req.params.locationId, req.body || {});
        return res.json({ ok: true, location: loc });
      } catch (err) {
        const msg = String(err.message || err);
        const status =
          msg === "missing_location_id" || msg === "no_updates" ? 400 : msg === "not_found" ? 404 : 500;
        return res.status(status).json({ ok: false, error: msg });
      }
    })
  );

  app.get(
    "/api/portal/access/locations/:locationId/policy",
    gateAccess(async (req, res) => {
      try {
        const policy = await getAccessPolicyForLocation(req.params.locationId);
        return res.json({ ok: true, policy });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.put(
    "/api/portal/access/locations/:locationId/policy",
    gateAccess(async (req, res) => {
      try {
        const policy = await upsertAccessPolicyForLocation(
          req.params.locationId,
          req.body || {},
          actorFromReq(req)
        );
        return res.json({ ok: true, policy });
      } catch (err) {
        return res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.get(
    "/api/portal/access/locations/:locationId/schedules",
    gateAccess(async (req, res) => {
      try {
        const schedules = await listSchedulesForLocation(req.params.locationId);
        return res.json({ ok: true, schedules });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.put(
    "/api/portal/access/locations/:locationId/schedules",
    gateAccess(async (req, res) => {
      try {
        const schedules = await replaceSchedulesForLocation(
          req.params.locationId,
          req.body?.schedules || []
        );
        return res.json({ ok: true, schedules });
      } catch (err) {
        return res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.get(
    "/api/portal/access/locations/:locationId/blackouts",
    gateAccess(async (req, res) => {
      try {
        const rows = await listBlackoutsForLocation(
          req.params.locationId,
          req.query.from,
          req.query.to
        );
        return res.json({ ok: true, blackouts: rows });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.post(
    "/api/portal/access/locations/:locationId/blackouts",
    gateAccess(async (req, res) => {
      try {
        const row = await createBlackoutForLocation(
          req.params.locationId,
          req.body || {},
          actorFromReq(req)
        );
        return res.status(201).json({ ok: true, blackout: row });
      } catch (err) {
        return res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.delete(
    "/api/portal/access/blackouts/:blackoutId",
    gateAccess(async (req, res) => {
      try {
        await deleteBlackout(req.params.blackoutId);
        return res.json({ ok: true });
      } catch (err) {
        return res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.get(
    "/api/portal/access/locations/:locationId/reservations",
    gateAccess(async (req, res) => {
      try {
        const rows = await listReservationsForLocation(
          req.params.locationId,
          req.query.from,
          req.query.to
        );
        return res.json({ ok: true, reservations: rows });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.get(
    "/api/portal/access/locations/:locationId/stats",
    gateAccess(async (req, res) => {
      try {
        const stats = await getLocationStats(
          req.params.locationId,
          req.query.date
        );
        return res.json({ ok: true, stats });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.post(
    "/api/portal/access/locations/:locationId/reservations",
    gateAccess(async (req, res) => {
      try {
        const body = { ...(req.body || {}), locationId: req.params.locationId };
        const row = await createReservationForPortal(body, actorFromReq(req));
        return res.status(201).json({ ok: true, reservation: row });
      } catch (err) {
        const code = err.code || err.message;
        return res.status(400).json({ ok: false, error: String(code) });
      }
    })
  );

  app.get(
    "/api/portal/access/reservations/:reservationId",
    gateAccess(async (req, res) => {
      try {
        const row = await getReservationDetail(req.params.reservationId);
        if (!row) return res.status(404).json({ ok: false, error: "not_found" });
        return res.json({ ok: true, reservation: row });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.post(
    "/api/portal/access/reservations/:reservationId/approve",
    gateAccess(async (req, res) => {
      try {
        const row = await approveReservation(
          req.params.reservationId,
          actorFromReq(req)
        );
        return res.json({ ok: true, reservation: row });
      } catch (err) {
        return res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.post(
    "/api/portal/access/reservations/:reservationId/cancel",
    gateAccess(async (req, res) => {
      try {
        const row = await cancelReservation(
          req.params.reservationId,
          actorFromReq(req)
        );
        return res.json({ ok: true, reservation: row });
      } catch (err) {
        return res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.post(
    "/api/portal/access/reservations/:reservationId/regenerate-pin",
    gateAccess(async (req, res) => {
      try {
        const row = await regeneratePin(req.params.reservationId, actorFromReq(req));
        return res.json({ ok: true, reservation: row });
      } catch (err) {
        return res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    })
  );

  app.patch(
    "/api/portal/access/reservations/:reservationId",
    gateAccess(async (req, res) => {
      try {
        const row = await patchReservationTimes(
          req.params.reservationId,
          req.body || {},
          actorFromReq(req)
        );
        return res.json({ ok: true, reservation: row });
      } catch (err) {
        const code = err.code || err.message;
        return res.status(400).json({ ok: false, error: String(code) });
      }
    })
  );
}

module.exports = { registerAccessRoutes };
