/**
 * Turnover Engine V1 — unit-scoped lifecycle + punch list (portal / service role).
 */
const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");
const { finalizeMaintenanceDraft } = require("./finalizeMaintenance");
const { mergeTicketUpdateRespectingPmOverride } = require("./ticketAssignmentGuard");

const ACTIVE_STATUSES = ["OPEN", "IN_PROGRESS"];

/** @type {{ task_key: string, title: string, category: string, sort_order: number }[]} */
const DEFAULT_TEMPLATE_LINES = [
  { task_key: "move_out_inspection", title: "Move-out inspection", category: "Inspection", sort_order: 10 },
  { task_key: "trash_removal", title: "Trash removal", category: "Turnover", sort_order: 20 },
  { task_key: "maintenance_repairs", title: "Maintenance repairs", category: "Maintenance", sort_order: 30 },
  { task_key: "paint_touchup", title: "Paint / touch-up", category: "Cosmetic", sort_order: 40 },
  { task_key: "cleaning", title: "Cleaning", category: "Cleaning", sort_order: 50 },
  { task_key: "final_inspection", title: "Final inspection", category: "Inspection", sort_order: 60 },
  { task_key: "photos", title: "Photos", category: "Documentation", sort_order: 70 },
  { task_key: "keys_locks", title: "Keys / locks", category: "Security", sort_order: 80 },
  { task_key: "ready_confirmation", title: "Ready confirmation", category: "Turnover", sort_order: 90 },
];

function normProp(code) {
  return String(code || "").trim().toUpperCase();
}

function isTicketStatusBlocking(statusRaw) {
  const s = String(statusRaw || "").trim().toLowerCase();
  if (!s) return false;
  const done = ["completed", "closed", "canceled", "cancelled", "resolved"];
  return !done.some((d) => s === d || s.includes(d));
}

function priorityToPortalUrgency(priority) {
  const p = String(priority || "").trim().toUpperCase();
  if (p === "HIGH" || p === "URGENT" || p === "URG") return "URGENT";
  return "NORMAL";
}

/**
 * @param {object} routerParameter
 * @returns {{ turnoverId: string | null, turnoverItemId: string | null }}
 */
function readTurnoverIdsFromPortalPayload(routerParameter) {
  const p = routerParameter || {};
  let turnoverId = null;
  let turnoverItemId = null;
  try {
    const j = JSON.parse(String(p._portalPayloadJson || "{}"));
    const tid = j.turnover_id != null ? j.turnover_id : j.turnoverId;
    const iid = j.turnover_item_id != null ? j.turnover_item_id : j.turnoverItemId;
    if (tid != null && String(tid).trim()) turnoverId = String(tid).trim();
    if (iid != null && String(iid).trim()) turnoverItemId = String(iid).trim();
  } catch (_) {
    /* ignore */
  }
  return { turnoverId, turnoverItemId };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {object} turnover
 * @param {object[]} items
 */
async function computeCurrentBlocker(sb, turnover, items) {
  const list = Array.isArray(items) ? items : [];
  const sorted = [...list].sort((a, b) => Number(a.sort_order) - Number(b.sort_order));

  for (const it of sorted) {
    const st = String(it.status || "").toUpperCase();
    if (st === "DONE" || st === "CANCELED") continue;

    const tid = String(it.linked_ticket_id || "").trim();
    if (tid && sb) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        tid
      );
      const { data: ticket } = isUuid
        ? await sb.from("tickets").select("ticket_id, status").eq("id", tid).maybeSingle()
        : await sb
            .from("tickets")
            .select("ticket_id, status")
            .eq("ticket_id", tid.toUpperCase())
            .maybeSingle();
      if (ticket && isTicketStatusBlocking(ticket.status)) {
        return `Open ticket ${ticket.ticket_id || tid}: ${String(ticket.status || "").trim()}`;
      }
    }

    if (st === "TODO" || st === "IN_PROGRESS") {
      return String(it.title || "Item").trim() || "Incomplete turnover item";
    }
  }
  return "";
}

/**
 * @param {string} turnoverId
 */
async function refreshTurnoverBlocker(sb, turnoverId) {
  const id = String(turnoverId || "").trim();
  if (!id || !sb) return;

  const { data: trow } = await sb.from("turnovers").select("*").eq("id", id).maybeSingle();
  if (!trow) return;

  const { data: items } = await sb
    .from("turnover_items")
    .select("id, title, status, sort_order, linked_ticket_id, source, metadata_json")
    .eq("turnover_id", id)
    .order("sort_order", { ascending: true });

  const blocker = await computeCurrentBlocker(sb, trow, items || []);
  await sb.from("turnovers").update({ current_blocker: blocker }).eq("id", id);
}

/**
 * @param {{ property_code?: string, unit_catalog_id?: string }} q
 */
async function listTurnovers(q) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", turnovers: [] };

  const pc = q.property_code != null ? normProp(q.property_code) : "";
  const uid = q.unit_catalog_id != null ? String(q.unit_catalog_id).trim() : "";

  let chain = sb.from("turnovers").select("*").order("started_at", { ascending: false });
  if (pc) chain = chain.eq("property_code", pc);
  if (uid) chain = chain.eq("unit_catalog_id", uid);

  const { data, error } = await chain;
  if (error) return { ok: false, error: error.message, turnovers: [] };
  return { ok: true, turnovers: data || [] };
}

/**
 * @param {string} id
 * @param {boolean} [withItems]
 */
async function getTurnoverById(id, withItems) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", turnover: null, items: [] };

  const tid = String(id || "").trim();
  if (!tid) return { ok: false, error: "missing_id", turnover: null, items: [] };

  const { data: turnover, error } = await sb.from("turnovers").select("*").eq("id", tid).maybeSingle();
  if (error) return { ok: false, error: error.message, turnover: null, items: [] };
  if (!turnover) return { ok: false, error: "not_found", turnover: null, items: [] };

  if (!withItems) return { ok: true, turnover, items: [] };

  const { data: items, error: iErr } = await sb
    .from("turnover_items")
    .select("*")
    .eq("turnover_id", tid)
    .order("sort_order", { ascending: true });
  if (iErr) return { ok: false, error: iErr.message, turnover, items: [] };
  return { ok: true, turnover, items: items || [] };
}

/**
 * @param {object} o
 * @param {string} o.property_code
 * @param {string} o.unit_catalog_id
 * @param {string} [o.target_ready_date]
 * @param {string} [o.summary]
 * @param {string} [o.created_by]
 * @param {string} [o.traceId]
 */
async function startTurnover(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const prop = normProp(o.property_code);
  const unitCatalogId = String(o.unit_catalog_id || "").trim();
  if (!prop || !unitCatalogId) return { ok: false, error: "missing_property_or_unit" };

  const { data: unit, error: uErr } = await sb
    .from("units")
    .select("id, property_code, unit_label")
    .eq("id", unitCatalogId)
    .maybeSingle();
  if (uErr) return { ok: false, error: uErr.message };
  if (!unit) return { ok: false, error: "unknown_unit" };
  if (normProp(unit.property_code) !== prop) return { ok: false, error: "unit_property_mismatch" };

  const { data: active } = await sb
    .from("turnovers")
    .select("id")
    .eq("property_code", prop)
    .eq("unit_catalog_id", unitCatalogId)
    .in("status", ACTIVE_STATUSES)
    .limit(1)
    .maybeSingle();

  if (active) {
    return { ok: false, error: "active_turnover_exists", existing_turnover_id: active.id };
  }

  const unitLabelSnapshot = String(unit.unit_label || "").trim();
  const nowIso = new Date().toISOString();
  const row = {
    property_code: prop,
    unit_catalog_id: unitCatalogId,
    unit_label_snapshot: unitLabelSnapshot,
    status: "IN_PROGRESS",
    target_ready_date: o.target_ready_date != null && String(o.target_ready_date).trim()
      ? String(o.target_ready_date).trim().slice(0, 10)
      : null,
    summary: o.summary != null ? String(o.summary).trim() : "",
    created_by: o.created_by != null ? String(o.created_by).trim() : "",
    started_at: nowIso,
    current_blocker: "",
  };

  const { data: inserted, error: tErr } = await sb.from("turnovers").insert(row).select("id").maybeSingle();
  if (tErr) return { ok: false, error: tErr.message };
  const turnoverId = inserted && inserted.id ? String(inserted.id) : "";

  const templateRows = DEFAULT_TEMPLATE_LINES.map((line) => ({
    turnover_id: turnoverId,
    title: line.title,
    category: line.category,
    task_key: line.task_key,
    sort_order: line.sort_order,
    source: "default_template",
    status: "TODO",
    metadata_json: { required_for_ready: true },
  }));

  const { error: insErr } = await sb.from("turnover_items").insert(templateRows);
  if (insErr) {
    await sb.from("turnovers").delete().eq("id", turnoverId);
    return { ok: false, error: insErr.message };
  }

  await appendEventLog({
    traceId: String(o.traceId || ""),
    log_kind: "portal",
    event: "TURNOVER_STARTED",
    payload: { turnover_id: turnoverId, property_code: prop, unit_catalog_id: unitCatalogId },
  });

  await refreshTurnoverBlocker(sb, turnoverId);
  const full = await getTurnoverById(turnoverId, true);
  return { ok: true, turnover_id: turnoverId, turnover: full.turnover, items: full.items };
}

/**
 * @param {string} turnoverId
 * @param {object} patch
 */
async function patchTurnover(turnoverId, patch, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(turnoverId || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const { data: existing } = await sb.from("turnovers").select("id, status").eq("id", id).maybeSingle();
  if (!existing) return { ok: false, error: "not_found" };

  /** @type {Record<string, unknown>} */
  const upd = {};
  if (patch.target_ready_date !== undefined) {
    const v = patch.target_ready_date;
    upd.target_ready_date =
      v != null && String(v).trim() ? String(v).trim().slice(0, 10) : null;
  }
  if (patch.summary !== undefined) {
    upd.summary = patch.summary != null ? String(patch.summary).trim() : "";
  }
  if (patch.status !== undefined) {
    const s = String(patch.status || "").trim().toUpperCase();
    if (s === "CANCELED") {
      upd.status = "CANCELED";
      upd.completed_at = new Date().toISOString();
      upd.current_blocker = "";
    }
  }

  if (!Object.keys(upd).length) return getTurnoverById(id, true);

  const { error } = await sb.from("turnovers").update(upd).eq("id", id);
  if (error) return { ok: false, error: error.message };

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "TURNOVER_PATCHED",
    payload: { turnover_id: id, patch: Object.keys(upd) },
  });

  return getTurnoverById(id, true);
}

/**
 * @param {string} turnoverId
 * @param {object} body
 */
async function addTurnoverItem(turnoverId, body, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(turnoverId || "").trim();
  const title = body.title != null ? String(body.title).trim() : "";
  if (!id || !title) return { ok: false, error: "missing_title_or_turnover" };

  const { data: t } = await sb.from("turnovers").select("id, status").eq("id", id).maybeSingle();
  if (!t) return { ok: false, error: "not_found" };
  if (!ACTIVE_STATUSES.includes(String(t.status || "").toUpperCase())) {
    return { ok: false, error: "turnover_not_active" };
  }

  const { data: maxRow } = await sb
    .from("turnover_items")
    .select("sort_order")
    .eq("turnover_id", id)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = maxRow && maxRow.sort_order != null ? Number(maxRow.sort_order) + 10 : 10;

  const row = {
    turnover_id: id,
    title,
    detail: body.detail != null ? String(body.detail).trim() : "",
    room_or_area: body.room_or_area != null ? String(body.room_or_area).trim() : "",
    category: body.category != null ? String(body.category).trim() : "",
    priority: body.priority != null ? String(body.priority).trim().toUpperCase() : "NORMAL",
    status: "TODO",
    sort_order: nextOrder,
    source: "walkthrough",
    photo_refs: Array.isArray(body.photo_refs) ? body.photo_refs : [],
    assigned_to: body.assigned_to != null ? String(body.assigned_to).trim() : "",
    due_at: body.due_at != null && String(body.due_at).trim() ? String(body.due_at).trim() : null,
    metadata_json:
      body.metadata_json && typeof body.metadata_json === "object" ? body.metadata_json : {},
  };

  const { data: ins, error } = await sb.from("turnover_items").insert(row).select("id").maybeSingle();
  if (error) return { ok: false, error: error.message };

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "TURNOVER_ITEM_ADDED",
    payload: { turnover_id: id, item_id: ins && ins.id },
  });

  await refreshTurnoverBlocker(sb, id);
  return { ok: true, item_id: ins && ins.id ? String(ins.id) : "" };
}

/**
 * @param {string} turnoverId
 * @param {string} itemId
 * @param {object} patch
 */
async function updateTurnoverItem(turnoverId, itemId, patch, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const tid = String(turnoverId || "").trim();
  const iid = String(itemId || "").trim();
  if (!tid || !iid) return { ok: false, error: "missing_id" };

  const { data: item } = await sb
    .from("turnover_items")
    .select("id, turnover_id")
    .eq("id", iid)
    .maybeSingle();
  if (!item || String(item.turnover_id) !== tid) return { ok: false, error: "not_found" };

  /** @type {Record<string, unknown>} */
  const upd = {};
  const fields = [
    "title",
    "detail",
    "room_or_area",
    "category",
    "priority",
    "status",
    "sort_order",
    "assigned_to",
    "due_at",
    "photo_refs",
    "metadata_json",
  ];
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(patch, f)) {
      if (f === "photo_refs") {
        upd[f] = Array.isArray(patch[f]) ? patch[f] : item.photo_refs;
      } else if (f === "priority" && patch[f] != null) {
        upd[f] = String(patch[f]).trim().toUpperCase();
      } else if (f === "status" && patch[f] != null) {
        upd[f] = String(patch[f]).trim().toUpperCase();
      } else {
        upd[f] = patch[f];
      }
    }
  }

  if (upd.status === "DONE") {
    upd.completed_at = new Date().toISOString();
  }

  if (!Object.keys(upd).length) return { ok: true };

  const { error } = await sb.from("turnover_items").update(upd).eq("id", iid);
  if (error) return { ok: false, error: error.message };

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "TURNOVER_ITEM_UPDATED",
    payload: { turnover_id: tid, item_id: iid, keys: Object.keys(upd) },
  });

  await refreshTurnoverBlocker(sb, tid);
  return { ok: true };
}

/**
 * @param {string} turnoverId
 * @param {string[]} orderedIds
 */
async function reorderTurnoverItems(turnoverId, orderedIds, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const tid = String(turnoverId || "").trim();
  const ids = Array.isArray(orderedIds) ? orderedIds.map((x) => String(x).trim()).filter(Boolean) : [];
  if (!tid || !ids.length) return { ok: false, error: "missing_order" };

  const { data: existing } = await sb.from("turnover_items").select("id").eq("turnover_id", tid);
  const allowed = new Set((existing || []).map((r) => String(r.id)));
  if (ids.some((x) => !allowed.has(x))) return { ok: false, error: "unknown_item" };

  let order = 10;
  for (const itemId of ids) {
    await sb.from("turnover_items").update({ sort_order: order }).eq("id", itemId);
    order += 10;
  }

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "TURNOVER_ITEMS_REORDERED",
    payload: { turnover_id: tid, count: ids.length },
  });

  await refreshTurnoverBlocker(sb, tid);
  return { ok: true };
}

/**
 * @param {string} turnoverId
 * @param {string} itemId
 * @param {string} ticketLookup — human ticket id or row uuid
 */
async function linkTicketToTurnoverItem(turnoverId, itemId, ticketLookup, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const tid = String(turnoverId || "").trim();
  const iid = String(itemId || "").trim();
  const hint = String(ticketLookup || "").trim();
  if (!tid || !iid || !hint) return { ok: false, error: "missing_fields" };

  const { data: item } = await sb
    .from("turnover_items")
    .select("id, turnover_id")
    .eq("id", iid)
    .maybeSingle();
  if (!item || String(item.turnover_id) !== tid) return { ok: false, error: "item_not_found" };

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    hint
  );
  const { data: ticket } = isUuid
    ? await sb.from("tickets").select("id, ticket_id, ticket_key, assignment_source").eq("id", hint).maybeSingle()
    : await sb
        .from("tickets")
        .select("id, ticket_id, ticket_key, assignment_source")
        .eq("ticket_id", hint.toUpperCase())
        .maybeSingle();

  if (!ticket || !ticket.ticket_id) return { ok: false, error: "ticket_not_found" };

  await sb
    .from("turnover_items")
    .update({
      linked_ticket_id: String(ticket.ticket_id),
    })
    .eq("id", iid);

  const turnoverLinkPatch = mergeTicketUpdateRespectingPmOverride(ticket, {
    turnover_id: tid,
    turnover_item_id: iid,
  });

  await sb
    .from("tickets")
    .update(turnoverLinkPatch)
    .eq("id", ticket.id);

  await sb.from("work_items").update({ turnover_id: tid }).eq("ticket_key", ticket.ticket_key);

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "TURNOVER_ITEM_LINKED_TICKET",
    payload: { turnover_id: tid, item_id: iid, ticket_id: ticket.ticket_id },
  });

  await refreshTurnoverBlocker(sb, tid);
  return { ok: true, ticket_id: String(ticket.ticket_id) };
}

/**
 * @param {object} o
 * @param {string} o.turnoverId
 * @param {string} o.itemId
 * @param {string} [o.actorPhoneE164] — MANAGER actor for finalize / conversation_ctx
 * @param {string} [o.traceId]
 */
async function createTicketFromTurnoverItem(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const turnoverId = String(o.turnoverId || "").trim();
  const itemId = String(o.itemId || "").trim();
  if (!turnoverId || !itemId) return { ok: false, error: "missing_ids" };

  const { data: trow } = await sb.from("turnovers").select("*").eq("id", turnoverId).maybeSingle();
  if (!trow) return { ok: false, error: "turnover_not_found" };
  if (!ACTIVE_STATUSES.includes(String(trow.status || "").toUpperCase())) {
    return { ok: false, error: "turnover_not_active" };
  }

  const { data: item } = await sb.from("turnover_items").select("*").eq("id", itemId).maybeSingle();
  if (!item || String(item.turnover_id) !== turnoverId) return { ok: false, error: "item_not_found" };
  if (String(item.linked_ticket_id || "").trim()) {
    return { ok: false, error: "item_already_linked" };
  }

  const actorKey = String(o.actorPhoneE164 || "").trim() || "portal_turnover";
  const issueText = [String(item.title || "").trim(), String(item.detail || "").trim()]
    .filter(Boolean)
    .join("\n");

  const category = String(item.category || "").trim() || "General";
  const urgency = priorityToPortalUrgency(item.priority);

  const routerParameter = {
    _portalAction: "create_ticket",
    _portalPayloadJson: JSON.stringify({
      category,
      urgency,
      status: "OPEN",
      serviceNote: "",
      turnover_id: turnoverId,
      turnover_item_id: itemId,
    }),
    _mediaJson: "",
  };

  const fin = await finalizeMaintenanceDraft({
    traceId: String(o.traceId || "turnover_ticket"),
    propertyCode: String(trow.property_code || "").trim(),
    unitLabel: String(trow.unit_label_snapshot || "").trim(),
    issueText,
    actorKey,
    mode: "MANAGER",
    locationType: "UNIT",
    locationId: undefined,
    locationLabelSnapshot: String(trow.unit_label_snapshot || "").trim(),
    unitCatalogId: String(trow.unit_catalog_id || "").trim(),
    reportSourceUnit: String(trow.unit_label_snapshot || "").trim(),
    reportSourcePhone: "",
    staffActorKey: actorKey,
    routerParameter,
    tenantPhoneE164: "",
    turnoverId,
    turnoverItemId: itemId,
  });

  if (!fin.ok) return { ok: false, error: fin.error || "finalize_failed", hint: fin.hint };

  await sb
    .from("turnover_items")
    .update({
      linked_ticket_id: String(fin.ticketId),
      linked_work_item_id: String(fin.workItemId),
    })
    .eq("id", itemId);

  const { data: newTicketRow } = await sb
    .from("tickets")
    .select("assignment_source")
    .eq("ticket_key", fin.ticketKey)
    .maybeSingle();

  const turnoverOnTicketPatch = mergeTicketUpdateRespectingPmOverride(newTicketRow || {}, {
    turnover_id: turnoverId,
    turnover_item_id: itemId,
  });

  await sb
    .from("tickets")
    .update(turnoverOnTicketPatch)
    .eq("ticket_key", fin.ticketKey);

  await sb.from("work_items").update({ turnover_id: turnoverId }).eq("ticket_key", fin.ticketKey);

  await appendEventLog({
    traceId: String(o.traceId || ""),
    log_kind: "portal",
    event: "TURNOVER_ITEM_TICKET_CREATED",
    payload: {
      turnover_id: turnoverId,
      item_id: itemId,
      ticket_id: fin.ticketId,
      work_item_id: fin.workItemId,
    },
  });

  await refreshTurnoverBlocker(sb, turnoverId);
  return {
    ok: true,
    ticket_id: fin.ticketId,
    work_item_id: fin.workItemId,
    ticket_key: fin.ticketKey,
  };
}

/**
 * @param {string} turnoverId
 * @param {object} [o]
 */
async function markTurnoverReady(turnoverId, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(turnoverId || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const { data: trow } = await sb.from("turnovers").select("*").eq("id", id).maybeSingle();
  if (!trow) return { ok: false, error: "not_found" };
  if (!ACTIVE_STATUSES.includes(String(trow.status || "").toUpperCase())) {
    return { ok: false, error: "turnover_not_active" };
  }

  const { data: items } = await sb.from("turnover_items").select("*").eq("turnover_id", id);
  const list = items || [];

  /** @type {string[]} */
  const reasons = [];

  for (const it of list) {
    const st = String(it.status || "").toUpperCase();
    if (st === "CANCELED") continue;
    if (st !== "DONE") {
      reasons.push(`Item not done: ${String(it.title || "").trim()}`);
    }
    const tid = String(it.linked_ticket_id || "").trim();
    if (tid) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        tid
      );
      const { data: ticket } = isUuid
        ? await sb.from("tickets").select("ticket_id, status").eq("id", tid).maybeSingle()
        : await sb
            .from("tickets")
            .select("ticket_id, status")
            .eq("ticket_id", tid.toUpperCase())
            .maybeSingle();
      if (ticket && isTicketStatusBlocking(ticket.status)) {
        reasons.push(`Linked ticket ${ticket.ticket_id} still ${ticket.status}`);
      }
    }
  }

  if (reasons.length) {
    return { ok: false, error: "ready_gate_failed", reasons };
  }

  const nowIso = new Date().toISOString();
  await sb
    .from("turnovers")
    .update({
      status: "READY",
      actual_ready_at: nowIso,
      completed_at: nowIso,
      current_blocker: "",
    })
    .eq("id", id);

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "TURNOVER_MARKED_READY",
    payload: { turnover_id: id },
  });

  return { ok: true };
}

module.exports = {
  DEFAULT_TEMPLATE_LINES,
  readTurnoverIdsFromPortalPayload,
  listTurnovers,
  getTurnoverById,
  startTurnover,
  patchTurnover,
  addTurnoverItem,
  updateTurnoverItem,
  reorderTurnoverItems,
  linkTicketToTurnoverItem,
  createTicketFromTurnoverItem,
  markTurnoverReady,
  refreshTurnoverBlocker,
  computeCurrentBlocker,
};
