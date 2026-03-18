/**
 * Propera Runner — local HTTP server for chaosRunner.js UI.
 * Node built-in modules only. Serves UI and API for runs; spawns chaosRunner.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");

const PORT_MIN = 3799;
const PORT_MAX = 3805;
const RUNS_DIR = path.join(__dirname, "..", "runs");
const CHAOS_SCRIPT = path.join(__dirname, "..", "chaosRunner.js");
const UI_DIR = path.join(__dirname, "ui");
const SANDBOX_CONFIG_PATH = path.join(__dirname, "sandbox-config.json");
const SAFE_JSON_FILE = /^run_[A-Za-z0-9_]+\.json$/;
const SAFE_RUN_FILE = /^run_[A-Za-z0-9_]+\.(json|txt)$/;

const SESSION_START_MS = Date.now();

function findPort(port, cb) {
  const server = http.createServer(function (req, res) {
    res.end();
  });
  server.listen(port, "127.0.0.1", function () {
    server.close(function () {
      cb(null, port);
    });
  });
  server.on("error", function () {
    if (port < PORT_MAX) findPort(port + 1, cb);
    else cb(new Error("No port available"));
  });
}

function openBrowser(url) {
  console.log("OPEN THIS URL IF IT DOES NOT AUTO-OPEN:", url);
  exec("start \"\" \"" + url.replace(/"/g, "\\\"") + "\"");
}

function listRuns(limit, sinceMs) {
  limit = limit || 200;
  if (!fs.existsSync(RUNS_DIR)) return [];
  const names = fs.readdirSync(RUNS_DIR).filter(function (n) {
    return n.startsWith("run_") && n.endsWith(".json");
  });
  let withMtime = names.map(function (n) {
    const fp = path.join(RUNS_DIR, n);
    return { name: n, mtimeMs: fs.statSync(fp).mtimeMs };
  });
  if (sinceMs != null && typeof sinceMs === "number") {
    withMtime = withMtime.filter(function (e) { return e.mtimeMs >= sinceMs; });
  }
  withMtime.sort(function (a, b) {
    return b.mtimeMs - a.mtimeMs;
  });
  const out = [];
  for (let i = 0; i < Math.min(limit, withMtime.length); i++) {
    const fp = path.join(RUNS_DIR, withMtime[i].name);
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch (_) {}
    const verdict = data.verdict || {};
    const stats = data.stats || {};
    out.push({
      runId: data.runId || withMtime[i].name.replace(/\.json$/, ""),
      phone: data.phone || "",
      profile: data.profile || "",
      startedAt: data.startedAt || "",
      endedAt: data.endedAt || "",
      verdict: { success: verdict.success, reason: verdict.reason || "" },
      stats: {
        turns: stats.turns,
        fragmentsSent: stats.fragmentsSent,
        wrongAnswers: stats.wrongAnswers,
        interruptions: stats.interruptions
      },
      file: withMtime[i].name
    });
  }
  return out;
}

function serveFile(filePath, contentType, res) {
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType || "application/octet-stream" });
    res.end(data);
  });
}

function handleRequest(req, res) {
  const url = req.url || "/";
  const pathname = url.split("?")[0];
  const query = {};
  (url.split("?")[1] || "").split("&").forEach(function (p) {
    const i = p.indexOf("=");
    if (i >= 0) query[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1));
  });

  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    const indexPath = path.join(UI_DIR, "index.html");
    serveFile(indexPath, "text/html", res);
    return;
  }

  if (pathname === "/api/sandboxConfig" && req.method === "GET") {
    try {
      if (fs.existsSync(SANDBOX_CONFIG_PATH)) {
        const raw = fs.readFileSync(SANDBOX_CONFIG_PATH, "utf8");
        const data = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, webappUrl: data.webappUrl || "", simSecret: data.simSecret || "", fromPhone: data.fromPhone || "" }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "sandbox-config.json not found" }));
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
    }
    return;
  }

  if (pathname === "/api/runs" && req.method === "GET") {
    const sinceMs = query.sinceMs != null ? parseInt(query.sinceMs, 10) : null;
    const list = listRuns(200, isNaN(sinceMs) ? null : sinceMs);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }

  if (pathname === "/api/run" && req.method === "GET") {
    const file = query.file;
    if (!file || !SAFE_JSON_FILE.test(file)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Invalid or missing file parameter" }));
      return;
    }
    const fp = path.join(RUNS_DIR, file);
    fs.readFile(fp, "utf8", function (err, data) {
      if (err) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Not found" }));
        return;
      }
      try {
        const json = JSON.parse(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      } catch (_) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
    });
    return;
  }

  if (pathname === "/api/runTxt" && req.method === "GET") {
    const runId = query.runId;
    if (!runId || !/^run_[A-Za-z0-9_]+$/.test(runId)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid runId");
      return;
    }
    const fp = path.join(RUNS_DIR, runId + ".txt");
    fs.readFile(fp, "utf8", function (err, data) {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (pathname === "/api/clearRuns" && req.method === "POST") {
    let body = "";
    req.on("data", function (chunk) {
      body += chunk;
    });
    req.on("end", function () {
      let olderThanMs = null;
      try {
        const parsed = JSON.parse(body || "{}");
        if (parsed.olderThanMs != null && typeof parsed.olderThanMs === "number") {
          olderThanMs = parsed.olderThanMs;
        }
      } catch (_) {}
      let deletedCount = 0;
      if (!fs.existsSync(RUNS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, deletedCount: 0 }));
        return;
      }
      const names = fs.readdirSync(RUNS_DIR).filter(function (n) {
        return SAFE_RUN_FILE.test(n);
      });
      names.forEach(function (n) {
        const fp = path.join(RUNS_DIR, n);
        try {
          const mtimeMs = fs.statSync(fp).mtimeMs;
          if (olderThanMs != null && mtimeMs >= olderThanMs) return;
          fs.unlinkSync(fp);
          deletedCount++;
        } catch (_) {}
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, deletedCount: deletedCount }));
    });
    return;
  }

  if (pathname === "/api/run" && req.method === "POST") {
    let body = "";
    req.on("data", function (chunk) {
      body += chunk;
    });
    req.on("end", function () {
      let config = {};
      try {
        config = JSON.parse(body || "{}");
      } catch (_) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const env = Object.assign({}, process.env, {
        WEBAPP_URL: config.webappUrl || "",
        SIM_WEBHOOK_SECRET: config.simSecret || "",
        FROM_PHONE: config.fromPhone || "",
        RUNS: String(config.runs != null ? config.runs : 1),
        CHAOS_PROFILE: (config.chaosLevel || "medium").toLowerCase(),
        MAX_TURNS: String(config.maxTurns != null ? config.maxTurns : 18),
        PHONES: config.phones ? String(config.phones).trim() : ""
      });
      const cwd = path.dirname(CHAOS_SCRIPT);
      const child = spawn("node", [path.basename(CHAOS_SCRIPT)], {
        cwd: cwd,
        env: env,
        shell: false
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", function (d) {
        stdout += d.toString();
      });
      child.stderr.on("data", function (d) {
        stderr += d.toString();
      });
      child.on("close", function (code) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, code: code, stdout: stdout, stderr: stderr }));
      });
      child.on("error", function (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, code: -1, stdout: stdout, stderr: stderr + (err && err.message) }));
      });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

findPort(PORT_MIN, function (err, port) {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  const server = http.createServer(handleRequest);
  server.listen(port, "127.0.0.1", function () {
    const url = "http://localhost:" + port + "/";
    console.log("Propera Runner at " + url);
    openBrowser(url);
  });
  server.on("error", function (e) {
    console.error("Server error:", e);
    process.exit(1);
  });
});
