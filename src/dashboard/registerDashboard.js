/**
 * Ops UI — event_log viewer (tenant threads). Gated by env; optional shared secret.
 */
const path = require("path");
const fs = require("fs");
const { dashboardEnabled, dashboardToken } = require("../config/env");
const { fetchEventLogForDashboard } = require("./eventLogApi");

let cachedHtml = null;

function loadDashboardHtml() {
  if (cachedHtml) return cachedHtml;
  const p = path.join(__dirname, "dashboardPage.html");
  cachedHtml = fs.readFileSync(p, "utf8");
  return cachedHtml;
}

function checkDashboardAuth(req) {
  if (!dashboardEnabled()) return { ok: false, status: 404 };
  const secret = dashboardToken();
  if (!secret) return { ok: true };
  const q = String(req.query.token || "").trim();
  const auth = req.headers.authorization || "";
  const bearer =
    auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (q === secret || bearer === secret) return { ok: true };
  return { ok: false, status: 401 };
}

/**
 * @param {import('express').Application} app
 */
function registerDashboardRoutes(app) {
  app.get("/dashboard", (req, res) => {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) {
      if (auth.status === 404) {
        return res
          .status(404)
          .type("text/plain")
          .send(
            "Dashboard disabled (set DASHBOARD_ENABLED=1 in production, or run with NODE_ENV=development). " +
              "Open with http://127.0.0.1:PORT/dashboard — use http not https."
          );
      }
      return res
        .status(401)
        .type("text/html")
        .send(
          "<!DOCTYPE html><html><body><p>Unauthorized. Add <code>?token=…</code> (same as DASHBOARD_TOKEN) or use Authorization header.</p></body></html>"
        );
    }
    try {
      const html = loadDashboardHtml();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (e) {
      res.status(500).send("Dashboard HTML missing.");
    }
  });

  app.get("/api/ops/event-log", async (req, res) => {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) {
      return res.status(auth.status || 401).json({ ok: false, error: "unauthorized" });
    }
    const hours = req.query.hours;
    const limit = req.query.limit;
    const telegramUserId = req.query.telegram_user_id;
    const actorKey = req.query.actor_key;
    const traceId = req.query.trace_id;
    const chatId = req.query.chat_id;
    try {
      const out = await fetchEventLogForDashboard({
        hours,
        limit,
        telegramUserId,
        actorKey,
        traceId,
        chatId,
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e && e.message ? String(e.message) : "error",
      });
    }
  });
}

module.exports = { registerDashboardRoutes };
