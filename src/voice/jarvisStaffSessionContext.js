/**
 * Jarvis live voice — staff session context (expression layer).
 * Compiles operational scope + thread hints for portal voice greeting.
 */
const { emit } = require("../logging/structuredLog");
const { compileOperationalScope } = require("../agent/operationalScope/compileOperationalScope");
const { getRoleDefinition } = require("../responsibility/roleCatalog");
const {
  findLatestJarvisThreadForActor,
  latestAwaitingProposal,
} = require("../dal/jarvisOperatorThreads");
const { listPropertiesForMenu } = require("../dal/intakeSession");
const { listAllOpenServiceTickets } = require("../agent/operationalScope/compileOperationalScope");
const {
  formatPropertyCatalogForJarvis,
} = require("../agent/proposals/resolvePropertyFromDatabaseText");
const { jarvisThreadEnabled } = require("../config/env");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient | null | undefined} sb
 * @param {string} staffId
 * @param {string} [propertyCode]
 */
async function loadStaffRoleHints(sb, staffId, propertyCode) {
  const id = String(staffId || "").trim();
  if (!sb || !id) return [];

  let query = sb
    .from("staff_property_roles")
    .select("role_key, property_code, is_primary")
    .eq("staff_id", id)
    .eq("active", true);

  const prop = String(propertyCode || "")
    .trim()
    .toUpperCase();
  if (prop) {
    query = query.or(`property_code.eq.${prop},property_code.eq.GLOBAL`);
  }

  const { data, error } = await query.limit(12);
  if (error || !Array.isArray(data)) return [];

  const seen = new Set();
  const hints = [];
  for (const row of data) {
    const key = String(row.role_key || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const def = getRoleDefinition(key);
    hints.push({
      roleKey: key,
      label: def ? def.label : key,
      propertyCode: String(row.property_code || "").trim(),
      isPrimary: row.is_primary === true,
    });
  }
  return hints;
}

/**
 * @param {object} scope
 * @param {object[]} roleHints
 * @param {object | null} thread
 * @param {object | null} [pageContext]
 * @param {string} [propertyCatalogLine]
 */
function formatJarvisStaffContextBlock(
  scope,
  roleHints,
  thread,
  pageContext,
  propertyCatalogLine,
  portfolioOpenCount,
  forVoice = false
) {
  const lines = ["## Staff Jarvis context (system — authoritative for this session)"];

  const actor = scope?.actor || {};
  if (actor.staffId) lines.push(`Staff id: ${actor.staffId}`);

  const anchor = scope?.anchor || {};
  if (anchor.propertyCode) {
    let loc = `Location anchor: property ${anchor.propertyCode}`;
    if (anchor.unit) loc += `, unit ${anchor.unit}`;
    if (anchor.humanTicketId) loc += `, ticket ${anchor.humanTicketId}`;
    lines.push(loc);
    if (!anchor.humanTicketId) {
      lines.push("No ticket pinned — staff may name a ticket id or unit; use resolve_open_ticket.");
    }
  } else if (pageContext?.propertyCode || pageContext?.property_code) {
    const prop = String(pageContext.propertyCode || pageContext.property_code || "")
      .trim()
      .toUpperCase();
    const unit = String(pageContext.unit || "").trim();
    let loc = `Portal view: property ${prop || "?"}`;
    if (unit) loc += `, unit ${unit}`;
    lines.push(loc);
    lines.push("No ticket pinned — staff may name a ticket id or unit; use resolve_open_ticket.");
  } else if (pageContext?.pathname) {
    lines.push(`Portal view: ${String(pageContext.pathname).trim()} (no ticket pinned).`);
    lines.push("Staff may name a ticket id or unit from anywhere — use resolve_open_ticket.");
  }

  if (scope?.story) lines.push(`Situation: ${scope.story}`);

  const catalog = String(propertyCatalogLine || "").trim();
  if (catalog) lines.push(catalog);

  const work = scope?.activeWork || [];
  if (work.length) {
    lines.push(`Your open work items (${work.length}):`);
    work.slice(0, 6).forEach((w, i) => {
      const tid = w.ticketHumanId ? ` ticket ${w.ticketHumanId}` : "";
      lines.push(
        `${i + 1}. ${w.propertyId || "?"}/${w.unitId || "?"}${tid} — ${w.state || "open"}`
      );
    });
  }

  if (portfolioOpenCount != null && portfolioOpenCount > 0 && !anchor.propertyCode) {
    lines.push(
      `Portfolio: ${portfolioOpenCount} open service ticket${portfolioOpenCount === 1 ? "" : "s"} — use list_open_service_tickets for the full list.`
    );
  }

  const opens = scope?.propertyOpenTickets || [];
  if (opens.length && !work.length) {
    lines.push(`Open tickets at property (${opens.length}):`);
    opens.slice(0, 5).forEach((t, i) => {
      const unit = t.unitLabel ? ` unit ${t.unitLabel}` : "";
      lines.push(`${i + 1}. ${t.humanTicketId || t.ticketRowId || "?"}${unit}`);
    });
  }

  if (roleHints.length) {
    const labels = roleHints.map((r) => r.label).slice(0, 4);
    lines.push(`Roles: ${labels.join(", ")}`);
  }

  if (thread) {
    const pending = latestAwaitingProposal(thread.pendingProposals || []);
    if (pending?.summary_human) {
      if (forVoice) {
        lines.push(
          "Thread may have an old unconfirmed action — ignore unless staff explicitly asks to continue it; never confirm or re-propose on your own."
        );
      } else {
        lines.push(`Pending confirm: ${pending.summary_human}`);
      }
    }
    const receipt = thread.lastReceipt;
    if (receipt && typeof receipt === "object") {
      const preview = receipt.reply_preview || receipt.summary;
      if (preview) lines.push(`Last action: ${String(preview).slice(0, 160)}`);
      if (receipt.human_ticket_id) {
        lines.push(`Last ticket: ${String(receipt.human_ticket_id).trim()}`);
      }
      if (
        String(receipt.committed_op || "") === "create_service_request" &&
        receipt.property_code &&
        receipt.unit_label
      ) {
        const win = String(receipt.preferred_window || "").trim();
        lines.push(
          `Multi-ticket context: ${receipt.property_code} unit ${receipt.unit_label}` +
            (win ? `, access window ${win}` : "") +
            " — reuse for next issue same unit unless staff changes it."
        );
      }
    }
  }

  lines.push(
    "Do not invent ticket ids, costs, or schedules — only facts from tools or this block. " +
      "At session start: brief hello by first name if known — never recite capabilities or open-work lists unless staff asks."
  );

  return lines.join("\n");
}

/**
 * @param {object} opts
 * @param {import("@supabase/supabase-js").SupabaseClient | null | undefined} opts.sb
 * @param {{ isStaff?: boolean, staff?: { staff_id?: string, display_name?: string }, staffActorKey?: string }} opts.staffContext
 * @param {object | null} [opts.pageContext]
 * @param {string} [opts.traceId]
 */
async function loadJarvisStaffSessionContext(opts) {
  const empty = {
    scope: null,
    roleHints: [],
    thread: null,
    staffDisplayName: "",
    promptBlock: "",
  };

  const sb = opts.sb;
  const staffContext = opts.staffContext || {};
  if (!staffContext.isStaff || !staffContext.staff) return empty;

  const staffId = String(staffContext.staff.staff_id || "").trim();
  const staffActorKey = String(staffContext.staffActorKey || "").trim();
  const staffDisplayName = String(staffContext.staff.display_name || "").trim();
  const pageContext = opts.pageContext || null;

  const routerParameter = {
    From: staffActorKey,
    _transportChannel: "portal",
    _portalPageContextJson: pageContext ? JSON.stringify(pageContext) : "",
  };

  let scope = null;
  try {
    scope = await compileOperationalScope({
      routerParameter,
      actorRole: "staff",
      staffId,
      actorKey: staffActorKey,
      transportChannel: "portal",
    });
  } catch (err) {
    emit({
      level: "warn",
      trace_id: opts.traceId || null,
      log_kind: "jarvis_voice",
      event: "staff_context_scope_failed",
      data: { error: String(err?.message || err) },
    });
  }

  const propertyCode =
    pageContext?.propertyCode ||
    pageContext?.property_code ||
    scope?.anchor?.propertyCode ||
    "";

  let roleHints = [];
  if (sb && staffId) {
    try {
      roleHints = await loadStaffRoleHints(sb, staffId, propertyCode);
    } catch (_) {
      roleHints = [];
    }
  }

  let thread = null;
  if (jarvisThreadEnabled() && sb && staffActorKey) {
    try {
      thread = await findLatestJarvisThreadForActor(sb, staffActorKey, "portal");
    } catch (_) {
      thread = null;
    }
  }

  let propertyCatalogLine = "";
  let portfolioOpenCount = null;
  try {
    const props = await listPropertiesForMenu();
    propertyCatalogLine = formatPropertyCatalogForJarvis(props);
  } catch (_) {
    propertyCatalogLine = "";
  }

  const pinnedProp =
    pageContext?.propertyCode ||
    pageContext?.property_code ||
    scope?.anchor?.propertyCode ||
    "";
  if (sb && !String(pinnedProp || "").trim()) {
    try {
      const allOpen = await listAllOpenServiceTickets({ limit: 80 });
      portfolioOpenCount = allOpen.length;
    } catch (_) {
      portfolioOpenCount = null;
    }
  }

  const forVoice = opts.forVoice === true;
  const promptBlock = scope
    ? formatJarvisStaffContextBlock(
        scope,
        roleHints,
        thread,
        pageContext,
        propertyCatalogLine,
        portfolioOpenCount,
        forVoice
      )
    : "";

  emit({
    level: "info",
    trace_id: opts.traceId || null,
    log_kind: "jarvis_voice",
    event: "staff_context_loaded",
    data: {
      staff_id: staffId,
      role_count: roleHints.length,
      work_count: (scope?.activeWork || []).length,
      has_thread: !!thread,
    },
  });

  return {
    scope,
    roleHints,
    thread,
    staffDisplayName,
    promptBlock,
  };
}

module.exports = {
  loadJarvisStaffSessionContext,
  loadStaffRoleHints,
  formatJarvisStaffContextBlock,
};
