/**
 * Jarvis reasoning loop — the read-only "understand and go look" agent.
 *
 * The model is given flexible read tools (today: lookup_tickets) and decides,
 * per question, which to call and how to filter. It may call them several times
 * (fetch → inspect → narrow), then writes a grounded answer. It is NOT an intent
 * parser: there is no fixed mapping from phrasing to a canned report.
 *
 * Hard rules enforced by the system prompt:
 *   - every fact comes from a tool result; never invent ids/counts/names/amounts
 *   - read-only; never claim an action was taken
 *   - admit what is missing instead of guessing
 *
 * @see docs/PROPERA_JARVIS_NORTH_STAR.md  (agent interprets, brain owns truth)
 * @see docs/JARVIS_SPINE.md § Read / Query layer
 */

const { openaiChatCompletionsWithRetry } = require("../../integrations/openaiTransport");
const {
  openaiApiKey,
  jarvisReasonModel,
  jarvisReasonMaxSteps,
  jarvisReasonTimeoutMs,
} = require("../../config/env");
const { lookupTickets, TICKET_LOOKUP_TOOL_SCHEMA } = require("./ticketLookupTool");
const { lookupCosts, COST_LOOKUP_TOOL_SCHEMA } = require("./costLookupTool");
const { getTicketDetail, TICKET_DETAIL_TOOL_SCHEMA } = require("./ticketDetailTool");
const { getUnitAssets, UNIT_ASSETS_TOOL_SCHEMA } = require("./unitAssetsTool");
const {
  getUnitServiceHistory,
  UNIT_SERVICE_HISTORY_TOOL_SCHEMA,
} = require("./unitServiceHistoryTool");
const { searchParts, PARTS_SEARCH_TOOL_SCHEMA } = require("./partsSearchTool");

const TOOLS = [
  TICKET_LOOKUP_TOOL_SCHEMA,
  COST_LOOKUP_TOOL_SCHEMA,
  TICKET_DETAIL_TOOL_SCHEMA,
  UNIT_ASSETS_TOOL_SCHEMA,
  UNIT_SERVICE_HISTORY_TOOL_SCHEMA,
  PARTS_SEARCH_TOOL_SCHEMA,
];
const TOOL_IMPL = {
  lookup_tickets: lookupTickets,
  lookup_costs: lookupCosts,
  get_ticket_detail: getTicketDetail,
  get_unit_assets: getUnitAssets,
  get_unit_service_history: getUnitServiceHistory,
  search_parts: searchParts,
};
const TOOL_RESULT_MAX_CHARS = 8000;

// Test seam: let unit tests drive the loop without a network call. Mirrors
// setLlmExtractorForTests in brain/intake/openaiStructuredSignal.js.
let _testChat = null;
function setReasonChatForTests(fn) {
  _testChat = typeof fn === "function" ? fn : null;
}
function clearReasonChatForTests() {
  _testChat = null;
}

function buildSystemPrompt(scope) {
  const today = new Date().toISOString().slice(0, 10);
  const story = scope && scope.story ? String(scope.story).trim() : "";
  return [
    "You are Propera Jarvis, a sharp property-operations analyst for staff and owners.",
    "You answer questions by LOOKING UP real data with the tools provided — never from memory or assumption.",
    "",
    "How to work:",
    "- Decide which lookups answer THIS specific question, then call tools with precise filters.",
    "- You may call tools multiple times: fetch, look at what came back, then narrow or pivot.",
    "- lookup_tickets = ticket facts; lookup_costs = money/spend; get_ticket_detail = the full story of one ticket; get_unit_assets = installed equipment (make/model/serial) for a unit; get_unit_service_history = a unit's past work incl. what was already tried.",
    "- For equipment questions ('the dishwasher in 410', a model/serial, parts), call get_unit_assets FIRST to resolve the real make/model, then reason from that.",
    "",
    "Parts ('find me a heating element for the dishwasher in 410'):",
    "  1. get_unit_assets to resolve the make/model.",
    "  2. search_parts with that make/model + the part needed.",
    "  3. Give the links: Amazon (usually cheapest/fastest for common parts) and a specialist like PartSelect",
    "     (pricier but finds almost anything). search_parts returns LINKS ONLY — it did NOT fetch prices, so do",
    "     not state a price or claim which is 'cheapest' as fact; present the general tradeoff. Never purchase anything.",
    "",
    "Diagnosis ('what could be causing X', 'why does the fridge keep failing'):",
    "  1. get_unit_assets for the make/model (if the registry is off, diagnose from the symptom + history instead).",
    "  2. get_unit_service_history (with assetType) to see prior repairs and what was already tried.",
    "  3. Then offer the most likely POSSIBLE causes — clearly labeled as possibilities to check, prioritized by what the",
    "     history suggests — and recommend the next diagnostic step. State facts (model, prior tickets, what was done) from",
    "     tools only. Never present a confirmed diagnosis, never promise a part or fix will solve it.",
    "- For 'how many' / 'why so many' questions, use countOnly with groupBy to see the breakdown.",
    "- For money questions use lookup_costs (amounts come back in cents and as formatted dollars).",
    "  If lookup_costs returns finance_not_enabled, say cost tracking is not turned on — never report $0.",
    "- For 'why' questions, look at the actual tickets/costs and describe the patterns you really see",
    "  (categories, units, timing, assignee, vendor). Separate observed facts from any suggestion you add.",
    "",
    "Hard rules:",
    "- Every fact in your answer must come from a tool result. Never invent ticket ids, counts, names, dates, or amounts.",
    "- If the data does not answer the question, say what you found and what is missing. Do not guess.",
    "- This is READ-ONLY. Never say or imply an action was taken (scheduled, closed, charged, messaged).",
    "- When a result is 'capped', the count is a floor — say 'at least N' rather than an exact total.",
    "",
    "Style: lead with the answer, be concise and direct like a capable colleague. No preamble, no bullet dumps unless asked.",
    "",
    "Today is " + today + ". Translate 'today' / 'this week' / 'this year' into date filters.",
    story
      ? "Current screen context (a hint, not a constraint — follow the question if it names something else): " + story
      : "No screen context; treat the question as portfolio-wide unless it names a property.",
  ].join("\n");
}

function buildUserContent(question, scope) {
  const a = (scope && scope.anchor) || {};
  let hint = "";
  if (a.propertyCode) {
    hint =
      "\n\n(context: the user is currently viewing property " +
      String(a.propertyCode).toUpperCase() +
      (a.unit ? ", unit " + a.unit : "") +
      ")";
  }
  return String(question || "").trim() + hint;
}

function safeJson(obj) {
  let s;
  try {
    s = JSON.stringify(obj);
  } catch (_) {
    return '{"ok":false,"error":"unserializable"}';
  }
  if (s.length > TOOL_RESULT_MAX_CHARS) s = s.slice(0, TOOL_RESULT_MAX_CHARS);
  return s;
}

function messageFrom(r) {
  return (
    r &&
    r.data &&
    Array.isArray(r.data.choices) &&
    r.data.choices[0] &&
    r.data.choices[0].message
  ) || null;
}

async function callChat(body, timeoutMs) {
  if (_testChat) return _testChat(body);
  return openaiChatCompletionsWithRetry({
    apiKey: openaiApiKey(),
    body,
    timeoutMs,
    maxRetries: 1,
  });
}

async function runToolCalls(toolCalls, trace) {
  const toolMessages = [];
  for (const tc of toolCalls) {
    const name = tc && tc.function && tc.function.name;
    let args = {};
    try {
      args = JSON.parse((tc.function && tc.function.arguments) || "{}");
    } catch (_) {
      args = {};
    }
    const impl = TOOL_IMPL[name];
    let result;
    if (!impl) {
      result = { ok: false, error: "unknown_tool:" + String(name) };
    } else {
      result = await impl(args).catch((e) => ({
        ok: false,
        error: String((e && e.message) || e),
      }));
    }
    trace.push({
      tool: String(name || ""),
      params: args,
      ok: result.ok !== false,
      total: typeof result.total === "number" ? result.total : null,
      returned: typeof result.returned === "number" ? result.returned : null,
      capped: !!result.capped,
    });
    toolMessages.push({
      role: "tool",
      tool_call_id: tc.id,
      content: safeJson(result),
    });
  }
  return toolMessages;
}

/**
 * @param {object} opts
 * @param {string} opts.question
 * @param {import("../operationalScope/types").OperationalScope} [opts.scope]
 * @returns {Promise<{ ok: boolean, reply?: string, steps?: number, trace?: object[], err?: string, exhausted?: boolean }>}
 */
async function runJarvisReasoning(opts) {
  const question = String((opts && opts.question) || "").trim();
  const scope = (opts && opts.scope) || {};
  if (!question) return { ok: false, err: "no_question" };
  if (!_testChat && !openaiApiKey()) return { ok: false, err: "no_api_key" };

  const model = jarvisReasonModel();
  const maxSteps = jarvisReasonMaxSteps();
  const budgetMs = jarvisReasonTimeoutMs();
  const startedAt = Date.now();
  const remaining = () => budgetMs - (Date.now() - startedAt);

  const messages = [
    { role: "system", content: buildSystemPrompt(scope) },
    { role: "user", content: buildUserContent(question, scope) },
  ];
  const trace = [];

  for (let step = 0; step < maxSteps; step++) {
    if (remaining() <= 1000) break;

    const r = await callChat(
      { model, messages, temperature: 0.2, tools: TOOLS, tool_choice: "auto" },
      Math.min(remaining(), 30000)
    );
    if (!r || !r.ok) {
      return { ok: false, err: (r && r.err) || "api_fail", trace };
    }
    const msg = messageFrom(r);
    if (!msg) return { ok: false, err: "no_message", trace };

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length) {
      const reply = String(msg.content || "").trim();
      if (reply) return { ok: true, reply, steps: step + 1, trace };
      break; // no tools, no content — force a summary below
    }

    messages.push({
      role: "assistant",
      content: msg.content || null,
      tool_calls: toolCalls,
    });
    const toolMessages = await runToolCalls(toolCalls, trace);
    for (const tm of toolMessages) messages.push(tm);
  }

  // Steps/budget exhausted (or a contentless turn): force one no-tool summary
  // so the user always gets a grounded answer from what we already fetched.
  if (remaining() > 1500) {
    const r = await callChat(
      { model, messages, temperature: 0.2, tools: TOOLS, tool_choice: "none" },
      Math.min(remaining(), 15000)
    );
    const msg = messageFrom(r);
    const reply = msg ? String(msg.content || "").trim() : "";
    if (reply) return { ok: true, reply, steps: maxSteps, trace, exhausted: true };
  }

  return { ok: false, err: "max_steps", trace };
}

module.exports = {
  runJarvisReasoning,
  setReasonChatForTests,
  clearReasonChatForTests,
};
