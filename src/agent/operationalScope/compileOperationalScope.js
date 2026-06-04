/**
 * Compile Operational Scope — read-only situation pack for Jarvis (Ask / Plan / briefings).
 * Does not write state or commit ticket identity; surfaces candidates for brain validation.
 * @see docs/PROPERA_JARVIS_NORTH_STAR.md § Operational Scope
 */

const { getSupabase } = require("../../db/supabase");
const { readPortalPageContext } = require("../contextEnvelope");
const { loadUnitLifecycleScope } = require("./loadUnitLifecycleScope");
const {
  listOpenWorkItemsForOwner,
  getTicketHumanIdByTicketKeys,
} = require("../../dal/workItems");
const { resolveWorkItemFromPageContext } = require("../resolvePageContextTarget");

const SCOPE_VERSION = "2";
const PROPERTY_OPEN_TICKET_LIMIT = 30;
const PORTFOLIO_OPEN_TICKET_LIMIT = 50;

const CLOSED_STATUSES = new Set([
  "completed",
  "canceled",
  "cancelled",
  "resolved",
  "closed",
  "done",
  "deleted",
]);

function normProp(s) {
  return String(s || "")
    .trim()
    .toUpperCase();
}

function normUnit(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s/g, "");
}

function isOpenTicketStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return true;
  return !CLOSED_STATUSES.has(s);
}

/**
 * @param {import("./types").OperationalScopeWorkItem[]} openWis
 * @param {import("./types").OperationalScopeAnchor} anchor
 */
function filterWorkItemsByAnchor(openWis, anchor) {
  const prop = normProp(anchor.propertyCode);
  const unit = normUnit(anchor.unit);
  if (!prop && !unit) return openWis;
  return openWis.filter((w) => {
    const wProp = normProp(w.propertyId);
    const wUnit = normUnit(w.unitId);
    if (prop && wProp !== prop) return false;
    if (unit && wUnit !== unit) return false;
    return true;
  });
}

/**
 * @param {import("./types").OperationalScopeAnchor} anchor
 * @param {import("./types").OperationalScopeWorkItem[]} openWis
 * @returns {Promise<import("./types").OperationalScopeFocus | null>}
 */
async function resolveFocusFromAnchor(anchor, openWis) {
  if (!anchor) return null;

  const humanId = String(anchor.humanTicketId || "")
    .trim()
    .toUpperCase();
  if (humanId) {
    const matches = openWis.filter(
      (w) =>
        String(w.ticketHumanId || "")
          .trim()
          .toUpperCase() === humanId
    );
    if (matches.length === 1) {
      return {
        workItemId: matches[0].workItemId,
        humanTicketId: humanId,
        reason: "ANCHOR_HUMAN_TICKET",
      };
    }
  }

  const ticketRowId = String(anchor.ticketRowId || "").trim();
  if (ticketRowId) {
    const sb = getSupabase();
    if (sb) {
      const { data: ticket } = await sb
        .from("tickets")
        .select("ticket_key, ticket_id")
        .eq("id", ticketRowId)
        .maybeSingle();
      const key = ticket && ticket.ticket_key ? String(ticket.ticket_key).trim() : "";
      const tid =
        ticket && ticket.ticket_id ? String(ticket.ticket_id).trim().toUpperCase() : "";
      if (key) {
        const byKey = openWis.filter((w) => String(w.ticketKey || "").trim() === key);
        if (byKey.length === 1) {
          return {
            workItemId: byKey[0].workItemId,
            ticketRowId,
            humanTicketId: tid || humanId || "",
            reason: "ANCHOR_TICKET_ROW",
          };
        }
      }
      if (tid || ticketRowId) {
        return {
          ticketRowId,
          humanTicketId: tid,
          reason: "ANCHOR_TICKET_ROW_NO_OPEN_WI",
        };
      }
    }
  }

  const prop = normProp(anchor.propertyCode);
  const unit = normUnit(anchor.unit);
  if (prop && unit && openWis.length > 0) {
    const candidates = openWis.filter(
      (w) => normProp(w.propertyId) === prop && normUnit(w.unitId) === unit
    );
    if (candidates.length === 1) {
      return {
        workItemId: candidates[0].workItemId,
        humanTicketId: candidates[0].ticketHumanId || "",
        reason: "ANCHOR_PROPERTY_UNIT_SINGLE",
      };
    }
  }

  return null;
}

/**
 * @param {string} propertyCode
 * @returns {Promise<import("./types").OperationalScopeOpenTicket[]>}
 */
async function listOpenTicketsForProperty(propertyCode) {
  const prop = normProp(propertyCode);
  if (!prop) return [];
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("portal_tickets_v1")
    .select(
      "ticket_row_id, ticket_id, property_code, unit_label, status, message_raw, category_final, category"
    )
    .eq("property_code", prop)
    .order("updated_at", { ascending: false })
    .limit(PROPERTY_OPEN_TICKET_LIMIT);

  if (error || !data) return [];

  return data
    .filter((row) => isOpenTicketStatus(row.status))
    .map((row) => ({
      ticketRowId: String(row.ticket_row_id || row.id || "").trim(),
      humanTicketId: String(row.ticket_id || "").trim(),
      propertyCode: prop,
      unitLabel: String(row.unit_label || "").trim(),
      status: String(row.status || "").trim(),
      summary: String(
        row.category_final || row.category || row.message_raw || ""
      )
        .trim()
        .slice(0, 200),
    }))
    .filter((t) => t.ticketRowId);
}

/**
 * All open service tickets across the portfolio (staff overview / voice list).
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<import("./types").OperationalScopeOpenTicket[]>}
 */
async function listAllOpenServiceTickets(opts = {}) {
  const limit = Math.min(
    Math.max(Number(opts.limit) || PORTFOLIO_OPEN_TICKET_LIMIT, 1),
    80
  );
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("portal_tickets_v1")
    .select(
      "ticket_row_id, ticket_id, property_code, unit_label, status, message_raw, category_final, category, priority, updated_at"
    )
    .order("updated_at", { ascending: false })
    .limit(limit * 4);

  if (error || !data) return [];

  return data
    .filter((row) => isOpenTicketStatus(row.status))
    .slice(0, limit)
    .map((row) => ({
      ticketRowId: String(row.ticket_row_id || row.id || "").trim(),
      humanTicketId: String(row.ticket_id || "").trim(),
      propertyCode: normProp(row.property_code),
      unitLabel: String(row.unit_label || "").trim(),
      status: String(row.status || "").trim(),
      summary: String(
        row.category_final || row.category || row.message_raw || ""
      )
        .trim()
        .slice(0, 200),
    }))
    .filter((t) => t.ticketRowId && t.humanTicketId);
}

/**
 * @param {string} staffId
 * @returns {Promise<import("./types").OperationalScopeWorkItem[]>}
 */
async function loadStaffActiveWork(staffId) {
  const id = String(staffId || "").trim();
  if (!id) return [];
  const sb = getSupabase();
  if (!sb) return [];

  const rawRows = await listOpenWorkItemsForOwner(id);
  const ticketKeys = rawRows.map((r) => String(r.ticket_key || "").trim());
  const ticketKeyToHuman = await getTicketHumanIdByTicketKeys(sb, ticketKeys);

  return rawRows.map((r) => ({
    workItemId: r.work_item_id,
    unitId: r.unit_id,
    propertyId: r.property_id,
    ticketKey: r.ticket_key ? String(r.ticket_key).trim() : "",
    ticketHumanId: ticketKeyToHuman.get(String(r.ticket_key || "").trim()) || "",
    state: r.state ? String(r.state) : "",
  }));
}

/**
 * @param {import("./types").OperationalScope} scope
 */
function buildStoryLine(scope) {
  const parts = [];
  const a = scope.anchor || {};
  if (a.propertyCode) {
    let line = "Property " + a.propertyCode;
    if (a.unit) line += ", unit " + a.unit;
    if (a.surface) line += " (" + a.surface + ")";
    parts.push(line);
  } else if (a.surface) {
    parts.push("Surface " + a.surface);
  }

  const nWi = (scope.activeWork || []).length;
  const nProp = (scope.propertyOpenTickets || []).length;
  if (nWi > 0) parts.push(nWi + " open work item(s) for actor");
  if (nProp > 0) parts.push(nProp + " open ticket(s) at property");

  const f = scope.focus;
  if (f && f.humanTicketId) {
    parts.push("Focus ticket " + f.humanTicketId);
  } else if (f && f.workItemId) {
    parts.push("Focus " + f.workItemId);
  }

  const ul = scope.unitLifecycle;
  if (ul) {
    if (ul.activeOccupancy && ul.activeOccupancy.residentName) {
      parts.push(
        "Current resident " +
          ul.activeOccupancy.residentName +
          (ul.activeOccupancy.startedAt
            ? " since " + String(ul.activeOccupancy.startedAt).slice(0, 10)
            : "")
      );
    } else if (ul.unitCatalogId) {
      parts.push("Unit vacant (no current occupancy recorded)");
    }
    if (ul.activeTurnover && ul.activeTurnover.turnoverId) {
      let tLine = "Active turnover " + (ul.activeTurnover.status || "OPEN");
      if (ul.turnoverBlocker) tLine += " — blocker: " + ul.turnoverBlocker;
      parts.push(tLine);
    }
    if (Array.isArray(ul.unitAssets) && ul.unitAssets.length > 0) {
      const labels = ul.unitAssets
        .slice(0, 6)
        .map((a) => {
          const type = String(a.assetType || "asset").replace(/_/g, " ");
          const model = String(a.model || "").trim();
          return model ? type + " (" + model + ")" : type;
        })
        .join(", ");
      parts.push(
        ul.unitAssets.length +
          " installed asset(s): " +
          labels +
          (ul.unitAssets.length > 6 ? ", …" : "")
      );
    }
  }

  if (!parts.length) return "No property or ticket anchor; general portfolio context.";
  return parts.join(". ") + ".";
}

/**
 * @param {object} opts
 * @param {Record<string, string | undefined>} [opts.routerParameter]
 * @param {'staff' | 'owner' | 'tenant' | 'unknown'} [opts.actorRole]
 * @param {string} [opts.staffId]
 * @param {string} [opts.actorKey]
 * @param {string} [opts.transportChannel]
 * @returns {Promise<import("./types").OperationalScope>}
 */
async function compileOperationalScope(opts) {
  const o = opts || {};
  const routerParameter = o.routerParameter || {};
  const pageContext = readPortalPageContext(routerParameter);
  const transportChannel = String(
    o.transportChannel || routerParameter._transportChannel || ""
  )
    .trim()
    .toLowerCase();

  /** @type {import("./types").OperationalScopeAnchor} */
  const anchor = pageContext
    ? {
        surface: pageContext.surface || "",
        pathname: pageContext.pathname || "",
        propertyCode: pageContext.propertyCode || "",
        unit: pageContext.unit || "",
        unitCatalogId: pageContext.unitCatalogId || "",
        turnoverId: pageContext.turnoverId || "",
        ticketRowId: pageContext.ticketRowId || "",
        humanTicketId: pageContext.humanTicketId || "",
        ticketLabel: pageContext.ticketLabel || "",
      }
    : {};

  let unitLifecycle = null;
  if (anchor.propertyCode && (anchor.unitCatalogId || anchor.unit)) {
    unitLifecycle = await loadUnitLifecycleScope({
      propertyCode: anchor.propertyCode,
      unitLabel: anchor.unit,
      unitCatalogId: anchor.unitCatalogId,
      turnoverId: anchor.turnoverId,
    });
  }

  const staffId = String(o.staffId || "").trim();
  let activeWork = [];
  if (staffId) {
    activeWork = await loadStaffActiveWork(staffId);
    activeWork = filterWorkItemsByAnchor(activeWork, anchor);
  }

  let propertyOpenTickets = [];
  if (anchor.propertyCode) {
    propertyOpenTickets = await listOpenTicketsForProperty(anchor.propertyCode);
    if (anchor.unit) {
      const u = normUnit(anchor.unit);
      propertyOpenTickets = propertyOpenTickets.filter(
        (t) => normUnit(t.unitLabel) === u
      );
    }
  }

  let focus = await resolveFocusFromAnchor(anchor, activeWork);

  if (!focus && staffId && pageContext && activeWork.length > 0) {
    const bodyHint = String(routerParameter.Body || "").trim();
    const deictic = await resolveWorkItemFromPageContext({
      bodyTrim: bodyHint || "this ticket",
      pageContext,
      openWis: activeWork,
    });
    if (deictic.wiId) {
      const wi = activeWork.find((w) => w.workItemId === deictic.wiId);
      focus = {
        workItemId: deictic.wiId,
        humanTicketId: wi ? wi.ticketHumanId : "",
        reason: deictic.reason || "PAGE_CONTEXT",
      };
    }
  }

  /** @type {import("./types").OperationalScope} */
  const scope = {
    version: SCOPE_VERSION,
    compiledAt: new Date().toISOString(),
    actor: {
      role: o.actorRole || "unknown",
      staffId: staffId || undefined,
      actorKey: String(o.actorKey || "").trim() || undefined,
      transportChannel: transportChannel || undefined,
    },
    anchor,
    activeWork,
    propertyOpenTickets,
    focus,
    unitLifecycle,
    story: "",
  };

  scope.story = buildStoryLine(scope);
  return scope;
}

module.exports = {
  compileOperationalScope,
  buildStoryLine,
  filterWorkItemsByAnchor,
  listOpenTicketsForProperty,
  listAllOpenServiceTickets,
  loadStaffActiveWork,
  SCOPE_VERSION,
};
