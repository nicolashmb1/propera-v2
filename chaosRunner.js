/**
 * Chaos Agent v2 — stateful tenant simulator for Propera Web App (doPost).
 * Uses SIM_MODE + SIM_WEBHOOK_SECRET. GSM-safe; no emoji/smart quotes.
 * Supports single run (default) or batch: --runs N, --phones "list".
 *
 * Example commands:
 *   node chaosRunner.js
 *   node chaosRunner.js --runs 25
 *   node chaosRunner.js --runs 25 --phones "+19085550101,+19085550102,+19085550103"
 *   SEED=42 RUNS=25 node chaosRunner.js
 *   node chaosRunner.js --url https://.../exec --secret X --runs 10 --profile high
 */

const fs = require("fs");
const path = require("path");

// ========== CLI / ENV PARSING ==========
function parseArgs() {
  const env = {
    url: process.env.WEBAPP_URL,
    secret: process.env.SIM_WEBHOOK_SECRET || process.env.SECRET,
    from: process.env.FROM_PHONE,
    turns: process.env.MAX_TURNS,
    seed: process.env.SEED,
    profile: (process.env.CHAOS_PROFILE || "medium").toLowerCase(),
    runs: process.env.RUNS,
    phones: process.env.PHONES
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) { env.url = argv[i + 1]; i++; }
    else if (argv[i] === "--secret" && argv[i + 1]) { env.secret = argv[i + 1]; i++; }
    else if (argv[i] === "--from" && argv[i + 1]) { env.from = argv[i + 1]; i++; }
    else if (argv[i] === "--turns" && argv[i + 1]) { env.turns = argv[i + 1]; i++; }
    else if (argv[i] === "--seed" && argv[i + 1]) { env.seed = argv[i + 1]; i++; }
    else if (argv[i] === "--profile" && argv[i + 1]) { env.profile = argv[i + 1]; i++; }
    else if (argv[i] === "--runs" && argv[i + 1]) { env.runs = argv[i + 1]; i++; }
    else if (argv[i] === "--phones" && argv[i + 1]) { env.phones = argv[i + 1]; i++; }
  }
  if (!env.url || String(env.url).trim() === "") {
    console.error("Missing WEBAPP_URL. Set env WEBAPP_URL or pass --url <url>.");
    process.exit(1);
  }
  if (!env.secret || String(env.secret).trim() === "") {
    console.error("Missing secret. Set env SIM_WEBHOOK_SECRET (or SECRET) or pass --secret <secret>.");
    process.exit(1);
  }
  const VALID_PROFILES = ["low", "medium", "high"];
  const url = String(env.url).trim();
  const secret = String(env.secret).trim();
  const fromPhone = env.from || "+19085550102";
  const maxTurns = parseInt(env.turns || "18", 10) || 18;
  const seedBase = env.seed != null && env.seed !== "" ? parseInt(env.seed, 10) : null;
  const profile = VALID_PROFILES.indexOf(env.profile) >= 0 ? env.profile : "medium";
  const runs = parseInt(env.runs || "1", 10) || 1;
  const phonesList = env.phones ? env.phones.split(",").map(function (p) { return String(p || "").trim(); }).filter(Boolean) : null;
  return { url, secret, fromPhone, maxTurns, seedBase, profile, runs, phonesList };
}

const CONFIG = parseArgs();

// Legacy globals for any code that still reads them (single-run compat)
const WEBAPP_URL = CONFIG.url;
const SECRET = CONFIG.secret;
const FROM_PHONE = CONFIG.fromPhone;
const MAX_TURNS = CONFIG.maxTurns;
const SEED = CONFIG.seedBase;
const PROFILE = CONFIG.profile;

// Answer banks (sim inputs only; GSM-safe ASCII)
const PROPERTIES = ["Penn", "Morris", "Murray", "Westfield", "Westgrand"];
const UNITS = ["214", "305", "12", "401", "102"];
const WINDOWS = ["Today afternoon", "Tomorrow 8-10am", "Tue 9-11am", "Wed 2-4pm"];
const ISSUES = ["sink clogged", "toilet leaking", "no heat", "door lock broken"];

// ========== SEEDED RNG ==========
let rngState = SEED != null ? (SEED >>> 0) : (Math.floor(Math.random() * 0xffffffff) >>> 0);
function rand() {
  rngState = (rngState + 0x6D2B79F5) | 0; // mulberry32
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// ========== TWIML PARSER ==========
function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractSmsTextFromTwiML(xmlString) {
  const raw = String(xmlString || "").trim();
  const match = raw.match(/<Message[^>]*>([\s\S]*?)<\/Message>/i);
  const inner = match ? match[1].trim() : "";
  return decodeXmlEntities(inner).trim().replace(/\s+/g, " ");
}

// ========== INFER ASK ==========
function inferAsk(outboundText) {
  const t = String(outboundText || "").toLowerCase();
  if (!t) return "UNKNOWN";
  if (/confirm your property|reply with the number|which property|select property/i.test(t)) return "PROPERTY";
  if (/unit number|apartment|unit\s*#|which unit|your unit/i.test(t)) return "UNIT";
  if (/availability|time window|schedule|when can we|8[-–]10|9[-–]11|preferred time/i.test(t)) return "SCHEDULE";
  if (/confirm.*yes|yes\/no|reply yes/i.test(t)) return "CONFIRM";
  if (/reply\s+1\)|reply 1\s|choose\s+1/i.test(t) && /\d\)/.test(t)) return "MENU";
  return "UNKNOWN";
}

// ========== BEHAVIOR POLICY ==========
function chooseBehavior(ask, turnIndex, profile, memory) {
  const lastAsk = memory.lastAsk || "UNKNOWN";
  const roll = rand();

  const weights = {
    low:   { correct: 0.85, wrong_field: 0.02, out_of_order: 0, interrupt: 0, emotional: 0, multi_issue: 0, fragment: 0.12, noise: 0.01 },
    medium: { correct: 0.50, wrong_field: 0.12, out_of_order: 0.05, interrupt: 0.08, emotional: 0.03, multi_issue: 0.05, fragment: 0.12, noise: 0.05 },
    high:  { correct: 0.25, wrong_field: 0.18, out_of_order: 0.12, interrupt: 0.15, emotional: 0.05, multi_issue: 0.10, fragment: 0.10, noise: 0.05 }
  };
  const w = weights[profile] || weights.medium;

  let type = "correct";
  if (roll < w.correct) type = "correct";
  else if (roll < w.correct + w.wrong_field) type = "wrong_field";
  else if (roll < w.correct + w.wrong_field + w.out_of_order) type = "out_of_order";
  else if (roll < w.correct + w.wrong_field + w.out_of_order + w.interrupt) type = "interrupt";
  else if (roll < w.correct + w.wrong_field + w.out_of_order + w.interrupt + w.emotional) type = "emotional";
  else if (roll < w.correct + w.wrong_field + w.out_of_order + w.interrupt + w.emotional + w.multi_issue) type = "multi_issue";
  else if (roll < w.correct + w.wrong_field + w.out_of_order + w.interrupt + w.emotional + w.multi_issue + w.fragment) type = "fragment";
  else type = "noise";

  const messages = [];
  let notes = "";

  switch (type) {
    case "correct":
      if (ask === "PROPERTY") messages.push(pick(["1", "2", "Penn", "the grand at penn"]));
      else if (ask === "UNIT") messages.push(pick(UNITS));
      else if (ask === "SCHEDULE") messages.push(pick(WINDOWS));
      else if (ask === "CONFIRM") messages.push(pick(["yes", "Yes"]));
      else if (ask === "MENU") messages.push("1");
      else messages.push(pick(ISSUES));
      notes = "answered as asked";
      break;
    case "wrong_field":
      if (ask === "PROPERTY") messages.push(pick(UNITS.concat(WINDOWS).concat(ISSUES)));
      else if (ask === "UNIT") messages.push(pick(PROPERTIES.concat(WINDOWS)));
      else if (ask === "SCHEDULE") messages.push(pick(UNITS.concat(PROPERTIES)));
      else messages.push(pick(ISSUES));
      notes = "wrong field";
      break;
    case "out_of_order":
      messages.push(pick(UNITS) + " " + pick(ISSUES));
      notes = "unit+issue before property";
      break;
    case "interrupt":
      messages.push(pick(ISSUES));
      notes = "new issue mid-flow";
      break;
    case "emotional":
      messages.push(pick(["This is urgent", "I need someone now", "Please help asap"]));
      notes = "emotional but GSM-safe";
      break;
    case "multi_issue":
      messages.push(pick(ISSUES) + " and " + pick(ISSUES));
      notes = "two issues";
      break;
    case "fragment": {
      const parts = pick(ISSUES).split(" ");
      for (let i = 0; i < parts.length; i++) messages.push(parts[i]);
      if (messages.length < 2) messages.push("please");
      notes = "split into " + messages.length + " parts";
      break;
    }
    case "noise":
      messages.push(pick(["hi", "hello", "hey"]));
      notes = "noise";
      break;
    default:
      messages.push(pick(ISSUES));
      notes = "fallback";
  }

  return { type, messages, notes };
}

// ========== HTTP SEND ==========
async function sendMessage(body, overrides) {
  const url = (overrides && overrides.url) || WEBAPP_URL;
  const secret = (overrides && overrides.secret) != null ? overrides.secret : SECRET;
  const from = (overrides && overrides.fromPhone) != null ? overrides.fromPhone : FROM_PHONE;
  if (!url.startsWith("https://")) {
    throw new Error("WEBAPP_URL is not absolute: " + url);
  }
  const params = new URLSearchParams();
  params.append("twhsec", secret);
  params.append("From", from);
  params.append("Body", body);
  params.append("MessageSid", "SIM" + Date.now() + "_" + Math.floor(rand() * 1e6));
  if (process.env.CHAOS_MODE) params.append("CHAOS_MODE", process.env.CHAOS_MODE);
  if (process.env.CHAOS_VIEW) params.append("CHAOS_VIEW", process.env.CHAOS_VIEW);
  if (process.env.CHAOS_VERBOSE) params.append("CHAOS_VERBOSE", process.env.CHAOS_VERBOSE);
  if (process.env.RUN_ID) params.append("runId", process.env.RUN_ID);
  if (process.env.TEST_ID) params.append("testId", process.env.TEST_ID);
  if (overrides && overrides.runId) params.append("runId", overrides.runId);
  if (overrides && overrides.turnIndex != null) params.append("turnIndex", String(overrides.turnIndex));
  const res = await fetch(url, { method: "POST", body: params });
  return res.text();
}

/** Extract run snapshot from TwiML response (<!-- SNAPSHOT_B64:... -->). Returns object or null. */
function parseSnapshotFromResponse(xmlString) {
  const raw = String(xmlString || "").trim();
  const match = raw.match(/<!--\s*SNAPSHOT_B64:([A-Za-z0-9+/=]+)\s*-->/);
  if (!match || !match[1]) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch (_) {
    return null;
  }
}

// ========== RUN STATE ==========
function createRun(phone, seed, profile) {
  const runId = "run_" + Date.now() + "_" + Math.floor(rand() * 10000);
  return {
    runId,
    seed: seed,
    profile: profile,
    startedAt: new Date().toISOString(),
    endedAt: null,
    phone: phone,
    turns: [],
    stats: { turns: 0, fragmentsSent: 0, wrongAnswers: 0, interruptions: 0, repeats: 0, successSignals: [] },
    verdict: { success: false, reason: "" }
  };
}

function ensureRunsDir() {
  const dir = path.join(process.cwd(), "runs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function persistRun(run) {
  run.endedAt = new Date().toISOString();
  const dir = ensureRunsDir();
  const jsonPath = path.join(dir, run.runId + ".json");
  fs.writeFileSync(jsonPath, JSON.stringify(run, null, 2), "utf8");

  const lines = ["Chaos Agent v2 Transcript " + run.runId, "Profile: " + run.profile, "Phone: " + run.phone, ""];
  run.turns.forEach(function (t) {
    lines.push("--- TURN " + t.i + " ---");
    lines.push("SENT: " + (t.sent ? t.sent.join(" | ") : ""));
    lines.push("RECV: " + (t.received || "").substring(0, 200));
    lines.push("ASK: " + (t.inferredAsk || ""));
    lines.push("BEHAVIOR: " + (t.behavior || ""));
    if (t.notes) lines.push("Notes: " + t.notes);
    lines.push("");
  });
  lines.push("Stats: " + JSON.stringify(run.stats));
  lines.push("Verdict: " + JSON.stringify(run.verdict));
  const hasSnapshots = run.turns && run.turns.some(function (t) { return t.snapshot; });
  if (hasSnapshots) lines.push("Snapshot data: see " + run.runId + ".json turn[].snapshot (directory, session, ctx, sheet1, devLog)");
  const txtPath = path.join(dir, run.runId + ".txt");
  fs.writeFileSync(txtPath, lines.join("\n"), "utf8");

  fs.writeFileSync(path.join(dir, "LAST_RUN_ID.txt"), run.runId + "\n", "utf8");
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(run, null, 2), "utf8");

  return { jsonPath, txtPath };
}

// ========== SUCCESS / STUCK DETECTION ==========
function isSuccessReply(text) {
  const t = String(text || "").toLowerCase();
  if (/ticket\s*id|ticket\s*#|we have logged|request (has been )?logged|confirmed|your (maintenance )?request/i.test(t)) return true;
  if (/ticket/.test(t) && /[a-z0-9-]{6,}/i.test(t)) return true;
  return false;
}

// ========== SINGLE RUN (same logic as original; parameterized) ==========
async function doOneRun(phone, seed, url, secret, maxTurns, profile, verbose) {
  rngState = (seed != null) ? (seed >>> 0) : (Math.floor(Math.random() * 0xffffffff) >>> 0);
  const opts = { url: url, secret: secret, fromPhone: phone };
  const run = createRun(phone, seed, profile);
  const memory = { lastAsk: "UNKNOWN", lastOutbound: "", repeatCount: 0 };

  let ask = "UNKNOWN";
  let behavior = chooseBehavior(ask, 0, profile, memory);
  if (behavior.type === "noise") {
    behavior = { type: "correct", messages: [pick(ISSUES)], notes: "opener issue" };
  } else if (behavior.type === "correct" && ask === "UNKNOWN") {
    behavior.messages = [pick(ISSUES)];
  }

  for (let i = 1; i <= maxTurns; i++) {
    const turn = { i, sent: [], received: "", inferredAsk: "", behavior: "", notes: "", ts: new Date().toISOString() };
    const toSend = behavior.messages && behavior.messages.length ? behavior.messages : [pick(ISSUES)];
    const runOpts = Object.assign({}, opts, { runId: run.runId, turnIndex: i });

    for (let j = 0; j < toSend.length; j++) {
      const body = toSend[j];
      const xml = await sendMessage(body, runOpts);
      turn.sent.push(body);
      turn.received = extractSmsTextFromTwiML(xml);
      const snap = parseSnapshotFromResponse(xml);
      if (snap) turn.snapshot = snap;
      if (toSend.length > 1 && j < toSend.length - 1) {
        await new Promise(r => setTimeout(r, 150 + Math.floor(rand() * 200)));
      }
    }
    if (toSend.length > 1) run.stats.fragmentsSent += (toSend.length - 1);

    turn.inferredAsk = inferAsk(turn.received);
    turn.behavior = behavior.type;
    turn.notes = behavior.notes;
    run.turns.push(turn);
    run.stats.turns = i;

    if (behavior.type === "wrong_field") run.stats.wrongAnswers += 1;
    if (behavior.type === "interrupt") run.stats.interruptions += 1;
    if (turn.received === memory.lastOutbound) {
      memory.repeatCount = (memory.repeatCount || 0) + 1;
    } else {
      memory.repeatCount = 0;
    }
    memory.lastOutbound = turn.received;
    memory.lastAsk = turn.inferredAsk;

    if (verbose) {
      console.log("TURN " + i);
      console.log("SENT:", turn.sent.join(" | "));
      console.log("RECV:", (turn.received || "").substring(0, 120));
      console.log("ASK:", turn.inferredAsk);
      console.log("BEHAVIOR:", turn.behavior);
      console.log("");
    }

    if (isSuccessReply(turn.received)) {
      run.verdict = { success: true, reason: "success_phrase" };
      run.stats.successSignals.push("turn " + i);
      break;
    }
    if (memory.repeatCount >= 3) {
      run.verdict = { success: false, reason: "stuck_same_reply_3x" };
      break;
    }

    behavior = chooseBehavior(turn.inferredAsk, i, profile, memory);
  }

  if (!run.verdict.reason) run.verdict = { success: false, reason: "max_turns" };
  return run;
}

/** Run one simulation; persist artifacts; return summary entry for batch. */
async function runSingleChaos(runIndex, config, verbose) {
  const phone = (config.phonesList && config.phonesList.length)
    ? config.phonesList[runIndex % config.phonesList.length]
    : config.fromPhone;
  const seed = config.seedBase != null ? config.seedBase + runIndex : null;
  const run = await doOneRun(
    phone,
    seed,
    config.url,
    config.secret,
    config.maxTurns,
    config.profile,
    verbose
  );
  persistRun(run);
  return {
    runId: run.runId,
    phone: run.phone,
    seed: seed,
    profile: run.profile,
    turns: run.stats.turns,
    success: run.verdict.success,
    reason: run.verdict.reason,
    stats: run.stats
  };
}

function computeAggregates(results) {
  const successCount = results.filter(function (r) { return r.success; }).length;
  const failCount = results.length - successCount;
  const failReasons = {};
  let sumTurns = 0, sumFragments = 0, sumWrong = 0, sumInterruptions = 0;
  results.forEach(function (r) {
    failReasons[r.reason] = (failReasons[r.reason] || 0) + 1;
    sumTurns += r.turns || 0;
    sumFragments += (r.stats && r.stats.fragmentsSent) || 0;
    sumWrong += (r.stats && r.stats.wrongAnswers) || 0;
    sumInterruptions += (r.stats && r.stats.interruptions) || 0;
  });
  const n = results.length;
  return {
    successCount,
    failCount,
    successRate: n ? (successCount / n) : 0,
    failReasons,
    avgTurns: n ? sumTurns / n : 0,
    avgFragmentsSent: n ? sumFragments / n : 0,
    avgWrongAnswers: n ? sumWrong / n : 0,
    avgInterruptions: n ? sumInterruptions / n : 0
  };
}

// ========== MAIN ==========
async function runChaos() {
  const cfg = CONFIG;
  const isBatch = cfg.runs > 1 || (cfg.phonesList && cfg.phonesList.length > 0);

  console.log("=== Chaos Agent v2 ===");
  console.log("CWD:", process.cwd());
  console.log("WEBAPP_URL:", cfg.url);
  console.log("SECRET set:", !!cfg.secret);
  console.log("FROM_PHONE:", cfg.fromPhone);
  console.log("MAX_TURNS:", cfg.maxTurns);
  console.log("SEED (base):", cfg.seedBase);
  console.log("PROFILE:", cfg.profile);
  console.log("RUNS:", cfg.runs);
  if (cfg.phonesList && cfg.phonesList.length) {
    console.log("PHONES:", cfg.phonesList.length, "phones (round-robin)");
  }
  console.log("");

  if (!isBatch) {
    const summary = await runSingleChaos(0, cfg, true);
    const run = { runId: summary.runId, verdict: { success: summary.success, reason: summary.reason }, stats: summary.stats };
    console.log("Stats:", JSON.stringify(run.stats, null, 2));
    console.log("Verdict:", JSON.stringify(run.verdict));
    const dir = ensureRunsDir();
    console.log("Saved:", path.join(dir, summary.runId + ".json"));
    console.log("Transcript:", path.join(dir, summary.runId + ".txt"));
    return;
  }

  const batchId = "batch_" + Date.now();
  const startedAt = new Date().toISOString();
  const results = [];

  for (let k = 0; k < cfg.runs; k++) {
    const summary = await runSingleChaos(k, cfg, false);
    results.push(summary);
    console.log(
      "RUN " + (k + 1) + "/" + cfg.runs +
      " success=" + summary.success +
      " turns=" + summary.turns +
      " reason=" + (summary.reason || "") +
      " runId=" + summary.runId +
      " phone=" + summary.phone
    );
    if (k < cfg.runs - 1) {
      const delayMs = 400 + Math.floor(rand() * 401);
      await new Promise(function (r) { setTimeout(r, delayMs); });
    }
  }

  const endedAt = new Date().toISOString();
  const aggregates = computeAggregates(results);
  const summaryPayload = {
    batchId,
    startedAt,
    endedAt,
    runsRequested: cfg.runs,
    runsCompleted: results.length,
    config: {
      url: cfg.url,
      profile: cfg.profile,
      maxTurns: cfg.maxTurns,
      seedBase: cfg.seedBase,
      phonesUsedCount: (cfg.phonesList && cfg.phonesList.length) || 0
    },
    results,
    aggregates: {
      successCount: aggregates.successCount,
      failCount: aggregates.failCount,
      successRate: aggregates.successRate,
      failReasons: aggregates.failReasons,
      avgTurns: Math.round(aggregates.avgTurns * 100) / 100,
      avgFragmentsSent: Math.round(aggregates.avgFragmentsSent * 100) / 100,
      avgWrongAnswers: Math.round(aggregates.avgWrongAnswers * 100) / 100,
      avgInterruptions: Math.round(aggregates.avgInterruptions * 100) / 100
    }
  };

  const dir = ensureRunsDir();
  const summaryPath = path.join(dir, "summary_" + batchId + ".json");
  fs.writeFileSync(summaryPath, JSON.stringify(summaryPayload, null, 2), "utf8");

  const reasonEntries = Object.entries(aggregates.failReasons).sort(function (a, b) { return b[1] - a[1]; });
  const top3 = reasonEntries.slice(0, 3);
  console.log("");
  console.log("--- Batch summary ---");
  console.log("Success rate:", (aggregates.successRate * 100).toFixed(1) + "%", "(" + aggregates.successCount + "/" + results.length + ")");
  console.log("Top 3 fail reasons:", top3.map(function (e) { return e[0] + ": " + e[1]; }).join("; "));
  console.log("Summary file:", summaryPath);
}

runChaos().catch(function (err) {
  console.error("Chaos run failed:", err);
  process.exit(1);
});
