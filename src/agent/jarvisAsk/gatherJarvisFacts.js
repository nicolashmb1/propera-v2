/**
 * Read-only fact pack for Jarvis Ask — brain data only, no writes.
 * @see docs/PROPERA_JARVIS_NORTH_STAR.md § Operational Scope
 */

const { getSupabase } = require("../../db/supabase");
const { listTicketCostEntriesForPortal } = require("../../dal/ticketCostEntries");
const {
  financeTicketCostsEnabled,
  financeCoreEnabled,
} = require("../../config/env");
const { listOpenTicketsForProperty, listAllOpenServiceTickets } = require("../operationalScope/compileOperationalScope");
const { resolveTicketTargetFromQuestion } = require("./resolveQuestionTargets");
const { loadOpenTicketTargetForUnit } = require("./loadTicketByUnit");
const { pickRecentTimeline } = require("./timeBrief");
const { classifyJarvisIntent, isPortfolioOpenListQuestion } = require("./classifyJarvisIntent");
const {
  parseServiceHistoryQuestion,
  parseServiceHistoryAnalysis,
  queryServiceHistory,
} = require("../jarvisQuery");

/**
 * @param {{ ticketRowId?: string, humanTicketId?: string }} o
 */
async function loadFocusTicketDetail(o) {
  const sb = getSupabase();
  if (!sb) return null;
  const rowId = String(o.ticketRowId || "").trim();
  const humanId = String(o.humanTicketId || "")
    .trim()
    .toUpperCase();
  if (!rowId && !humanId) return null;

  let query = sb.from("portal_tickets_v1").select(
    "ticket_row_id, ticket_id, property_code, property_display_name, unit_label, status, category, category_final, message_raw, assigned_name, assign_to, preferred_window, priority, tenant_name, service_notes, created_at, updated_at, closed_at, timeline_json"
  );
  if (rowId) query = query.eq("ticket_row_id", rowId);
  else query = query.eq("ticket_id", humanId);

  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;

  const timeline = pickRecentTimeline(data.timeline_json, 5);

  return {
    ticketRowId: String(data.ticket_row_id || "").trim(),
    humanTicketId: String(data.ticket_id || "").trim(),
    property:
      String(data.property_display_name || "").trim() ||
      String(data.property_code || "").trim(),
    propertyCode: String(data.property_code || "").trim(),
    unit: String(data.unit_label || "").trim(),
    status: String(data.status || "").trim(),
    category: String(data.category_final || data.category || "").trim(),
    assignee: String(data.assigned_name || data.assign_to || "").trim(),
    preferredWindow: String(data.preferred_window || "").trim(),
    priority: String(data.priority || "").trim(),
    tenantName: String(data.tenant_name || "").trim(),
    serviceNotes: String(data.service_notes || "").trim().slice(0, 200),
    createdAt: data.created_at || "",
    updatedAt: data.updated_at || "",
    closedAt: data.closed_at || "",
    messagePreview: String(data.message_raw || "")
      .trim()
      .slice(0, 280),
    timeline,
  };
}

/**
 * @param {string} ticketRowId
 */
async function loadTicketCostSummary(ticketRowId) {
  if (!financeTicketCostsEnabled()) return null;
  const id = String(ticketRowId || "").trim();
  if (!id) return null;
  const res = await listTicketCostEntriesForPortal(id);
  if (!res.ok || !res.entries) return null;
  const entries = res.entries || [];
  let companyCents = 0;
  let tenantCents = 0;
  for (const e of entries) {
    companyCents += Number(e.amountCents || 0);
    const tc = e.tenantChargeAmountCents;
    if (tc != null && isFinite(Number(tc))) tenantCents += Number(tc);
  }
  return {
    entryCount: entries.length,
    companyCents,
    tenantCents,
  };
}

/**
 * @param {string} propertyCode
 */
async function loadPropertyMaintenanceSpend(propertyCode) {
  if (!financeCoreEnabled() && !financeTicketCostsEnabled()) return null;
  const prop = String(propertyCode || "")
    .trim()
    .toUpperCase();
  if (!prop) return null;
  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from("portal_properties_v1")
    .select(
      "property_code, name, open, urgent, units, occupied, maintenance_spend_cents_month, maintenance_tenant_charge_cents_month, maintenance_cost_entry_count_month, maintenance_spend_cents_ytd, maintenance_tenant_charge_cents_ytd, maintenance_cost_entry_count_ytd"
    )
    .eq("property_code", prop)
    .maybeSingle();

  if (error || !data) return null;

  return {
    propertyCode: prop,
    name: String(data.name || "").trim(),
    openTicketCount: Number(data.open) || 0,
    urgentTicketCount: Number(data.urgent) || 0,
    unitCount: Number(data.units) || 0,
    occupiedCount: Number(data.occupied) || 0,
    monthLabel: "current UTC month",
    companyCentsMonth: Number(data.maintenance_spend_cents_month) || 0,
    tenantCentsMonth: Number(data.maintenance_tenant_charge_cents_month) || 0,
    entryCountMonth: Number(data.maintenance_cost_entry_count_month) || 0,
    companyCentsYtd: Number(data.maintenance_spend_cents_ytd) || 0,
    tenantCentsYtd: Number(data.maintenance_tenant_charge_cents_ytd) || 0,
    entryCountYtd: Number(data.maintenance_cost_entry_count_ytd) || 0,
  };
}

/**
 * @param {import("../operationalScope/types").OperationalScope} scope
 * @param {string} [question]
 */
async function gatherJarvisFacts(scope, question) {
  const anchor = scope.anchor || {};
  const focus = scope.focus || {};
  const q = String(question || "").trim();
  const intents = classifyJarvisIntent(q);

  const propertyCode =
    String(anchor.propertyCode || "").trim().toUpperCase() || "";

  // Service history depends only on the question + anchor property — not on the
  // focus-ticket chain below. Start it now so it overlaps those reads. Best
  // effort: a failed history query degrades to null rather than failing the answer.
  const serviceHistoryPromise =
    intents.has("SERVICE_HISTORY")
      ? (async () => {
          const parsed = parseServiceHistoryQuestion(q, { propertyCode });
          if (!parsed?.keywords?.length) return null;
          return queryServiceHistory({
            issueKeywords: parsed.keywords,
            daysBack: parsed.daysBack,
            propertyCode: parsed.propertyCode || propertyCode || undefined,
            issueLabel: parsed.issueLabel,
            analysisMode: parsed.analysisMode || parseServiceHistoryAnalysis(q),
          });
        })().catch(() => null)
      : Promise.resolve(null);

  let openTicketsAtProperty = scope.propertyOpenTickets || [];
  if (propertyCode) {
    openTicketsAtProperty = await listOpenTicketsForProperty(propertyCode);
  } else if (isPortfolioOpenListQuestion(q) || (intents.has("OPEN_LIST") && !propertyCode)) {
    openTicketsAtProperty = await listAllOpenServiceTickets();
  }

  const scopeForResolve = { ...scope, propertyOpenTickets: openTicketsAtProperty };

  let resolvedFromQuestion = false;
  let questionResolution = null;

  const fromQuestion = q
    ? resolveTicketTargetFromQuestion(scopeForResolve, q)
    : null;
  let ticketRowId =
    String(focus.ticketRowId || anchor.ticketRowId || "").trim() || "";
  let humanTicketId =
    String(focus.humanTicketId || anchor.humanTicketId || "")
      .trim()
      .toUpperCase() || "";

  if (fromQuestion) {
    questionResolution = fromQuestion;
    if (fromQuestion.reason === "QUESTION_UNIT_AMBIGUOUS") {
      /* formatter lists candidates */
    } else if (fromQuestion.humanTicketId || fromQuestion.ticketRowId) {
      ticketRowId = String(fromQuestion.ticketRowId || ticketRowId).trim();
      humanTicketId = String(fromQuestion.humanTicketId || humanTicketId)
        .trim()
        .toUpperCase();
      resolvedFromQuestion = !!(
        fromQuestion.reason === "QUESTION_UNIT_SINGLE" ||
        fromQuestion.reason === "QUESTION_HUMAN_TICKET_ID" ||
        fromQuestion.reason === "QUESTION_HUMAN_TICKET_ID_DIRECT"
      );
    } else if (
      fromQuestion.reason === "QUESTION_UNIT_NO_OPEN_TICKET" &&
      propertyCode &&
      fromQuestion.unitLabel
    ) {
      const dbTarget = await loadOpenTicketTargetForUnit(
        propertyCode,
        fromQuestion.unitLabel
      );
      if (dbTarget) {
        questionResolution = dbTarget;
        ticketRowId = dbTarget.ticketRowId;
        humanTicketId = String(dbTarget.humanTicketId || "").toUpperCase();
        resolvedFromQuestion = true;
      }
    }
  }

  const focusTicket = await loadFocusTicketDetail({ ticketRowId, humanTicketId });

  // Cost summary and property spend are independent of each other once the
  // focus ticket is known — run them together instead of back to back.
  const costRowId = focusTicket?.ticketRowId || ticketRowId;
  const propCode =
    propertyCode || String(focusTicket?.propertyCode || "").trim().toUpperCase();
  const [costSummary, propertySituation] = await Promise.all([
    costRowId ? loadTicketCostSummary(costRowId) : Promise.resolve(null),
    propCode ? loadPropertyMaintenanceSpend(propCode) : Promise.resolve(null),
  ]);

  const serviceHistory = await serviceHistoryPromise;

  return {
    scopeStory: scope.story || "",
    anchor,
    focus,
    focusTicket,
    openTicketsAtProperty,
    activeWork: scope.activeWork || [],
    unitLifecycle: scope.unitLifecycle || null,
    costSummary,
    propertySituation,
    propertyMaintenanceSpend: propertySituation,
    resolvedFromQuestion,
    questionResolution,
    intents: Array.from(intents),
    serviceHistory,
  };
}

module.exports = {
  gatherJarvisFacts,
  loadFocusTicketDetail,
  loadTicketCostSummary,
  loadPropertyMaintenanceSpend,
};
