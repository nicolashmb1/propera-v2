/**
 * Propera V2 — minimal HTTP shell (Phase 0).
 * GAS + Sheets remain production until explicit cutover.
 */
const express = require("express");
const { port, nodeEnv } = require("./config/env");
const { createTrace } = require("./trace/createTrace");
const { isDbConfigured, pingDb } = require("./db/supabase");
const { requestContext } = require("./middleware/requestContext");
const { boot } = require("./logging/structuredLog");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(requestContext);

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    "Propera V2 skeleton — OK. Use GET /health for JSON status."
  );
});

app.get("/health", async (req, res) => {
  const trace = createTrace({ traceId: req.traceId });
  trace.step("HEALTH", { path: "/health" });

  let db = { configured: isDbConfigured(), ok: null, error: null };
  if (db.configured) {
    const ping = await pingDb();
    db.ok = ping.ok;
    if (!ping.ok && ping.error) db.error = ping.error;
    trace.snap("db_ping", { configured: db.configured, ok: db.ok, error: db.error });
  }

  trace.perf("HEALTH");
  res.json({
    ok: true,
    service: "propera-v2",
    phase: 0,
    nodeEnv,
    uptimeSec: Math.floor(process.uptime()),
    traceId: trace.traceId,
    db,
  });
});

const server = app.listen(port, () => {
  boot("listen", { port, nodeEnv });
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${port} is already in use (another app or an old "npm start").\n\n` +
        `Fix options:\n` +
        `  1) Stop the other process, then run npm start again.\n` +
        `  2) Use another port: e.g. PORT=8081 in .env (not 3000 — reserved for propera-app)\n\n` +
        `Windows — find PID on port ${port}:\n` +
        `  netstat -ano | findstr :${port}\n` +
        `Then end that PID (only if it is node/propera):  taskkill /PID <pid> /F\n`
    );
    process.exit(1);
  }
  throw err;
});
