/**
 * Deterministic portal / PM ticket writes — parses `Body` + `_portalPayloadJson`
 * from `/webhooks/portal` (`buildRouterParameterFromPortal`) and updates `tickets` + `work_items`.
 */

const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");
const {
  cancelPendingLifecycleTimersForTicketKey,
} = require("./lifecycleTimers");
const { extractUnit, normalizeUnit_ } = require("../brain/shared/extractUnitGas");

/** Matches `formatHumanTicketId` — PREFIX-MMDDYY-4digits */
const HUMAN_ID = "([A-Za-z0-9]{2,12}-\\d{6}-\\d{4})";

const HUMAN_TICKET_ID_RE = new RegExp(`^${HUMAN_ID}$`, "i");

/** V2 composite inverse ids e.g. `PENN-031` from `v2:V2PENN:031` (not MMDDYY-####). */
const SHORT_HUMAN_TICKET_ID_RE = /^[A-Za-z0-9]{2,12}-\d{1,6}$/i;

/** Postgres `tickets.id` (uuid) from propera-app row payloads */
const TICKET_ROW_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Text after `label:` until the next `fieldName:` (or end). Avoids stopping at the first period.
 * @param {string} full
 * @param {RegExp} labelRe — regex for the label prefix (e.g. issue colon, case-insensitive)
 * @param {RegExp} stopBeforeNextLabel
 */
function sliceLabeledFreeText(full, labelRe, stopBeforeNextLabel) {
  const s = String(full || "");
  const m = s.match(labelRe);
  if (!m || m.index === undefined) return undefined;
  const start = m.index + m[0].length;
  const tail = s.slice(start);
  const rel = tail.search(stopBeforeNextLabel);
  return rel === -1 ? tail.trim() : tail.slice(0, rel).trim();
}

/** Next `fieldName:` segment (`service notes:` matches `service(?:\\s+notes?)?\\s*:`). */
const LABEL_AHEAD =
  "(?:category|status|urgency|priority|issue|service(?:\\s+notes?)?|preferred\\s+window|schedule|unit|apt|apartment)\\s*:";

const STOP_BEFORE_NEXT_PORTAL_FIELD = new RegExp(
  "(?:\\.\\s+|\\s+)(?=" + LABEL_AHEAD + ")",
  "i"
);

/** PM clients often nest the row under `ticket` / `fields` / `updates` / etc. */
const PORTAL_PAYLOAD_NEST_KEYS = [
  "ticket",
  "row",
  "data",
  "payload",
  "patch",
  "changes",
  "updates",
  /** Form / PATCH bodies — often carry `message_raw` while siblings only carry meta. */
  "fields",
  "edits",
  "ticketPatch",
];

/**
 * Skip `undefined` so a partial `updates` object does not wipe keys merged from `ticket`.
 * @param {Record<string, unknown>} target
 * @param {unknown} source
 */
function assignDefinedShallow(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const k of Object.keys(source)) {
    if (source[k] !== undefined) target[k] = source[k];
  }
}

/**
 * Shallow-merge nested objects onto a single dict so `ticket.issue` becomes `issue`.
 * @param {object} j
 * @returns {Record<string, unknown>}
 */
function flattenPortalPayload(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return {};
  /** @type {Record<string, unknown>} */
  const merged = { ...j };
  for (const nk of PORTAL_PAYLOAD_NEST_KEYS) {
    assignDefinedShallow(merged, j[nk]);
  }
  return merged;
}

/**
 * Prefer DB-shaped keys first (PM saves often send full `tickets` row with `message_raw`).
 * @param {Record<string, unknown>} j
 */
function pickIssueFromPayload(j) {
  const order = [
    "message_raw",
    "messageRaw",
    "issue",
    "issueText",
    "message",
    "summary",
    "description",
    "problem",
    "details",
  ];
  for (const k of order) {
    if (!Object.prototype.hasOwnProperty.call(j, k)) continue;
    const v = j[k] == null ? "" : String(j[k]).trim();
    if (v) return v;
  }
  for (const k of order) {
    if (Object.prototype.hasOwnProperty.call(j, k)) {
      return j[k] == null ? "" : String(j[k]).trim();
    }
  }
  return undefined;
}

/**
 * Human display id (`PENN-MMDDYY-####`) or row UUID — apps often send `id` only.
 * @param {Record<string, unknown>} j — flattened portal payload
 * @returns {string} normalized hint (uppercase human id or lowercase uuid), or ""
 */
function pickTicketLookupHintFromFlat(j) {
  const keys = ["ticket_id", "humanTicketId", "ticketId", "id"];
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(j, k) || j[k] == null) continue;
    const s = String(j[k]).trim();
    if (!s) continue;
    if (HUMAN_TICKET_ID_RE.test(s)) return s.toUpperCase();
  }
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(j, k) || j[k] == null) continue;
    const s = String(j[k]).trim();
    if (!s) continue;
    if (TICKET_ROW_UUID_RE.test(s)) return s.toLowerCase();
  }
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(j, k) || j[k] == null) continue;
    const s = String(j[k]).trim();
    if (!s) continue;
    if (SHORT_HUMAN_TICKET_ID_RE.test(s)) return s.toUpperCase();
  }
  return "";
}

function hasUpdatableTicketFields(f) {
  if (!f || typeof f !== "object") return false;
  if (f.statusRaw) return true;
  if (Object.prototype.hasOwnProperty.call(f, "issue")) return true;
  if (Object.prototype.hasOwnProperty.call(f, "category")) return true;
  if (Object.prototype.hasOwnProperty.call(f, "serviceNotes")) return true;
  if (Object.prototype.hasOwnProperty.call(f, "preferredWindow")) return true;
  if (Object.prototype.hasOwnProperty.call(f, "urgency")) return true;
  if (
    Object.prototype.hasOwnProperty.call(f, "unit") &&
    String(f.unit || "").trim()
  )
    return true;
  if (f.attachmentsAdd && Array.isArray(f.attachmentsAdd) && f.attachmentsAdd.length) return true;
  return false;
}

/**
 * PM clients often put the edited description in HTTP `body` while JSON only has
 * ticketId + dropdowns (status / category / urgency). `buildRouterParameterFromPortal`
 * maps that to `RouterParameter.Body`.
 *
 * @param {string} body — `RouterParameter.Body`
 * @param {{ humanTicketId: string, rest: string } | null} updateLine — from `parseUpdateTicketLine`
 */
function shouldCoalescePortalBodyAsIssue(body, updateLine) {
  const b = String(body || "").trim();
  if (!b) return false;
  if (b.toLowerCase() === "noop") return false;
  if (updateLine) return false;
  if (b.startsWith("#")) return false;
  if (new RegExp(`^\\s*${HUMAN_ID}\\s+canceled\\s*$`, "i").test(b)) return false;
  if (new RegExp(`^\\s*Update\\s+${HUMAN_ID}\\b`, "i").test(b)) return false;
  if (new RegExp(`^${HUMAN_ID}$`, "i").test(b)) return false;
  return true;
}

/**
 * @param {string} body
 */
function parseSoftDeleteFromBody(body) {
  const raw = String(body || "").trim();
  const cancelRe = new RegExp(`^\\s*${HUMAN_ID}\\s+canceled\\s*$`, "i");
  const mCancel = raw.match(cancelRe);
  if (mCancel) return { kind: "soft_delete", humanTicketId: mCancel[1].toUpperCase() };
  const cancelShort = /^\s*([A-Za-z0-9]{2,12}-\d{1,6})\s+canceled\s*$/i;
  const mShort = raw.match(cancelShort);
  if (mShort) return { kind: "soft_delete", humanTicketId: mShort[1].toUpperCase() };
  return null;
}

/**
 * @param {string} body
 * @returns {{ humanTicketId: string, rest: string } | null}
 */
function parseUpdateTicketLine(body) {
  const raw = String(body || "").trim();
  const updRe = new RegExp(`^\\s*Update\\s+${HUMAN_ID}\\b`, "i");
  const mUpd = raw.match(updRe);
  if (!mUpd) return null;
  return {
    humanTicketId: mUpd[1].toUpperCase(),
    rest: raw.slice(mUpd[0].length).replace(/^\.\s*/, "").trim(),
  };
}

/**
 * Free-text segment after `Update HUMAN` (same line or following sentences).
 * @param {string} rest
 * @returns {Record<string, unknown>}
 */
function parseFieldsFromUpdateRest(rest) {
  const r = String(rest || "").trim();
  const fields = {};
  if (!r) return fields;

  const st = r.match(/\bstatus\s+([^\n.]+?)(?=\.\s|\.\s*$|\s*$)/i);
  if (st) fields.statusRaw = st[1].trim();

  const issueVal = sliceLabeledFreeText(
    r,
    /\bissue:\s*/i,
    STOP_BEFORE_NEXT_PORTAL_FIELD
  );
  if (issueVal !== undefined) fields.issue = issueVal;

  const cat = r.match(/\bcategory:?\s*([^\n.]+)/i);
  if (cat) fields.category = cat[1].trim();

  const urg = r.match(/\b(?:urgency|priority):?\s*([^\n.]+)/i);
  if (urg) fields.urgency = urg[1].trim();

  const snVal = sliceLabeledFreeText(
    r,
    /\bservice(?:\s+notes?)?:\s*/i,
    STOP_BEFORE_NEXT_PORTAL_FIELD
  );
  if (snVal !== undefined) fields.serviceNotes = snVal;

  const pwVal = sliceLabeledFreeText(
    r,
    /\b(?:preferred\s+window|schedule|preferred):?\s*/i,
    STOP_BEFORE_NEXT_PORTAL_FIELD
  );
  if (pwVal !== undefined) fields.preferredWindow = pwVal;

  /** NL / wire: "apt 322 to 323", "unit 101 as 102" — destination is the right-hand unit. */
  const swapUnit = r.match(
    /\b(?:apt|apartment|unit)\s+(\d{1,5}[A-Za-z\-]?)\s*(?:to|→|into|as)\s+(\d{1,5}[A-Za-z\-]?)\b/i
  );
  if (swapUnit && swapUnit[2]) {
    fields.unit = normalizeUnit_(swapUnit[2]);
  } else {
    const unitLabeled = sliceLabeledFreeText(
      r,
      /\b(?:unit|apt|apartment)\s*:\s*/i,
      STOP_BEFORE_NEXT_PORTAL_FIELD
    );
    if (unitLabeled !== undefined && String(unitLabeled || "").trim()) {
      fields.unit = normalizeUnit_(unitLabeled);
    } else if (!fields.unit) {
      const shouldBe = r.match(/\b(?:should\s+be|meant)\s+(\d{1,5}[A-Za-z\-]?)\b/i);
      if (shouldBe && shouldBe[1]) {
        fields.unit = normalizeUnit_(shouldBe[1]);
      } else if (/\b(?:unit|apt|apartment)\b/i.test(r)) {
        const ex = extractUnit(r);
        if (ex) fields.unit = normalizeUnit_(ex);
      }
    }
  }

  return fields;
}

/**
 * Structured fields from the original portal POST (mirrored in `_portalPayloadJson`).
 * @param {Record<string, string | undefined>} routerParameter
 * @returns {{ humanTicketId: string, fields: Record<string, unknown> }}
 */
function extractPortalPayloadTicketFields(routerParameter) {
  let raw = {};
  try {
    raw = JSON.parse(String((routerParameter && routerParameter._portalPayloadJson) || "{}"));
  } catch (_) {
    return { humanTicketId: "", fields: {} };
  }

  const j = flattenPortalPayload(raw);

  const humanTicketId = pickTicketLookupHintFromFlat(j);
  const idOk =
    !!humanTicketId &&
    (HUMAN_TICKET_ID_RE.test(humanTicketId) ||
      TICKET_ROW_UUID_RE.test(humanTicketId) ||
      SHORT_HUMAN_TICKET_ID_RE.test(humanTicketId));

  const fields = {};

  if ("status" in j && j.status != null && String(j.status).trim()) {
    fields.statusRaw = String(j.status).trim();
  }
  if ("category" in j) {
    fields.category = j.category == null ? "" : String(j.category).trim();
  }
  if ("urgency" in j) {
    fields.urgency = j.urgency == null ? "" : String(j.urgency).trim();
  } else if ("priority" in j) {
    fields.urgency = j.priority == null ? "" : String(j.priority).trim();
  }
  const issueFromPayload = pickIssueFromPayload(j);
  if (issueFromPayload !== undefined) fields.issue = issueFromPayload;
  if ("serviceNote" in j) {
    fields.serviceNotes = j.serviceNote == null ? "" : String(j.serviceNote).trim();
  } else if ("serviceNotes" in j) {
    fields.serviceNotes = j.serviceNotes == null ? "" : String(j.serviceNotes).trim();
  }
  if ("preferredWindow" in j || "schedule" in j || "preferred_window" in j) {
    let v;
    if ("preferredWindow" in j) v = j.preferredWindow;
    else if ("schedule" in j) v = j.schedule;
    else v = j.preferred_window;
    fields.preferredWindow = v == null ? "" : String(v).trim();
  }

  const rawAttach = Array.isArray(j.attachments)
    ? j.attachments
    : Array.isArray(j.attachmentUrls)
      ? j.attachmentUrls
      : [];
  const urls = rawAttach.map((x) => String(x || "").trim()).filter(Boolean);
  if (urls.length) fields.attachmentsAdd = urls;

  if ("unit" in j && j.unit != null && String(j.unit).trim()) {
    fields.unit = normalizeUnit_(String(j.unit));
  } else if ("unit_label" in j && j.unit_label != null && String(j.unit_label).trim()) {
    fields.unit = normalizeUnit_(String(j.unit_label));
  } else if ("apt" in j && j.apt != null && String(j.apt).trim()) {
    fields.unit = normalizeUnit_(String(j.apt));
  }

  return { humanTicketId: idOk ? humanTicketId : "", fields };
}

/**
 * @param {Record<string, string | undefined>} routerParameter
 * @returns {{ kind: 'soft_delete', humanTicketId: string } | { kind: 'update', humanTicketId: string, fields: object } | null}
 */
function parsePortalPmTicketRequest(routerParameter) {
  const body = String((routerParameter && routerParameter.Body) || "").trim();

  const soft = parseSoftDeleteFromBody(body);
  if (soft) return soft;

  const line = parseUpdateTicketLine(body);
  const payload = extractPortalPayloadTicketFields(routerParameter);

  const humanTicketId =
    (line && line.humanTicketId) || (payload.humanTicketId && payload.humanTicketId.trim()) || "";
  const restFields = line ? parseFieldsFromUpdateRest(line.rest) : {};
  /** JSON / `_portalPayloadJson` wins over wire `Update …` rest so structured `message_raw` is not truncated by the text parser. */
  const fields = { ...restFields, ...payload.fields };

  if (!humanTicketId) return null;

  const ticketIdFromJson = !!(payload.humanTicketId && String(payload.humanTicketId).trim());
  if (
    ticketIdFromJson &&
    !Object.prototype.hasOwnProperty.call(fields, "issue") &&
    shouldCoalescePortalBodyAsIssue(body, line)
  ) {
    fields.issue = String(body || "").trim();
  }

  if (!hasUpdatableTicketFields(fields)) return null;

  return { kind: "update", humanTicketId, fields };
}

/**
 * @param {string} body — backwards-compatible: body-only (no JSON merge).
 * @returns {{ kind: 'soft_delete', humanTicketId: string } | { kind: 'update', humanTicketId: string, fields: object } | null}
 */
function parsePortalPmTicketBody(body) {
  return parsePortalPmTicketRequest({ Body: body, _portalPayloadJson: "{}" });
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizePortalTicketStatus(raw) {
  const t = String(raw || "")
    .trim()
    .toLowerCase();
  if (!t) return "";
  if (t === "open" || t === "reopen" || t === "re-opened" || t === "reopened") return "Open";
  if (t === "completed" || t === "complete" || t === "done" || t === "closed")
    return "Completed";
  if (
    t === "deleted" ||
    t === "delete" ||
    t === "canceled" ||
    t === "cancelled" ||
    t === "void"
  )
    return "Deleted";
  if (t.includes("progress")) return "In Progress";
  return String(raw || "").trim().slice(0, 120);
}

/**
 * Remote / portal "priority" (urgency) → `tickets.priority` text.
 * @param {string} raw
 * @returns {string}
 */
function normalizePortalPriority(raw) {
  const t = String(raw || "")
    .trim()
    .toLowerCase();
  if (!t) return "normal";
  if (t === "urgent" || t === "emergency" || t === "critical") return "urgent";
  if (t === "high") return "high";
  if (t === "low") return "low";
  if (t === "normal" || t === "medium" || t === "moderate") return "normal";
  return String(raw || "").trim().slice(0, 80) || "normal";
}

async function fetchTicketByHumanId(sb, humanTicketId) {
  const id = String(humanTicketId || "").trim();
  if (!id) return null;
  const { data, error } = await sb
    .from("tickets")
    .select(
      "ticket_id, ticket_key, property_code, status, message_raw, attachments, is_imported_history"
    )
    .eq("ticket_id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * @param {object} sb — Supabase client
 * @param {string} lookupHint — human `ticket_id` or row UUID
 */
async function fetchTicketForPortalMutation(sb, lookupHint) {
  const hint = String(lookupHint || "").trim();
  if (!hint) return null;
  if (TICKET_ROW_UUID_RE.test(hint)) {
    const { data, error } = await sb
      .from("tickets")
      .select(
        "ticket_id, ticket_key, property_code, status, message_raw, attachments, is_imported_history"
      )
      .eq("id", hint)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  }
  if (HUMAN_TICKET_ID_RE.test(hint) || SHORT_HUMAN_TICKET_ID_RE.test(hint)) {
    return fetchTicketByHumanId(sb, hint.toUpperCase());
  }
  return null;
}

async function updateWorkItemsByTicketKey(sb, ticketKey, wiPatch) {
  const key = String(ticketKey || "").trim();
  if (!key) return { ok: true, skipped: true };
  const { error } = await sb.from("work_items").update(wiPatch).eq("ticket_key", key);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * @param {object} o
 * @param {string} o.traceId
 * @param {number} [o.traceStartMs] — for `applyPreferredWindowByTicketKey` / structured log timing
 * @param {Record<string, string | undefined>} o.routerParameter
 * @returns {Promise<object | null>} staffRun-shaped object, or null to fall through
 */
async function tryPortalPmTicketMutation(o) {
  const traceId = String(o.traceId || "");
  const traceStartMs =
    o.traceStartMs != null && isFinite(Number(o.traceStartMs))
      ? Number(o.traceStartMs)
      : undefined;
  const routerParameter = (o && o.routerParameter) || {};
  const sb = getSupabase();

  let parsed = parsePortalPmTicketRequest(routerParameter);
  if (
    !parsed &&
    sb &&
    o.staffAmendContext &&
    String(o.staffAmendContext.staffId || "").trim()
  ) {
    const { tryStaffNaturalLanguageTicketAmend } = require("./staffTicketAmendNl");
    const nl = await tryStaffNaturalLanguageTicketAmend({
      sb,
      traceId,
      routerParameter,
      staffId: String(o.staffAmendContext.staffId || "").trim(),
      staffActorKey: String(o.staffAmendContext.staffActorKey || "").trim(),
    });
    if (nl && nl.amendRun) return nl.amendRun;
    if (nl && nl.parsed) parsed = nl.parsed;
  }

  if (!parsed) return null;

  if (!sb) {
    return {
      ok: false,
      brain: "portal_ticket_mutation",
      replyText: "Database is not configured.",
      resolution: { error: "no_db", parsed },
    };
  }

  const ticket = await fetchTicketForPortalMutation(sb, parsed.humanTicketId);
  if (!ticket) {
    await appendEventLog({
      traceId,
      log_kind: "portal",
      event: "PORTAL_PM_TICKET_NOT_FOUND",
      payload: { lookup_hint: parsed.humanTicketId, kind: parsed.kind },
    });
    return {
      ok: false,
      brain: "portal_ticket_mutation",
      replyText: "Ticket not found: " + parsed.humanTicketId,
      resolution: { error: "ticket_not_found", humanTicketId: parsed.humanTicketId },
    };
  }

  const resolvedTicketId = String(ticket.ticket_id || "").trim();
  const now = new Date().toISOString();
  const ticketKey = String(ticket.ticket_key || "").trim();

  if (ticket.is_imported_history === true) {
    await appendEventLog({
      traceId,
      log_kind: "portal",
      event: "PORTAL_PM_TICKET_IMPORTED_READ_ONLY",
      payload: { ticket_id: resolvedTicketId, kind: parsed.kind },
    });
    return {
      ok: false,
      brain: "portal_ticket_mutation",
      replyText:
        "This ticket is historical (imported from GAS) and cannot be changed.",
      resolution: {
        error: "imported_history_read_only",
        humanTicketId: resolvedTicketId,
      },
    };
  }

  if (parsed.kind === "soft_delete") {
    const { error: tErr } = await sb
      .from("tickets")
      .update({
        status: "Deleted",
        closed_at: now,
        updated_at: now,
        last_activity_at: now,
      })
      .eq("ticket_id", resolvedTicketId);
    if (tErr) {
      return {
        ok: false,
        brain: "portal_ticket_mutation",
        replyText: "Could not delete ticket: " + tErr.message,
        resolution: { error: tErr.message },
      };
    }
    const wiRes = await updateWorkItemsByTicketKey(sb, ticketKey, {
      status: "CANCELED",
      state: "DONE",
      substate: "",
      updated_at: now,
    });
    if (!wiRes.ok) {
      return {
        ok: false,
        brain: "portal_ticket_mutation",
        replyText: "Ticket marked deleted but work item update failed: " + wiRes.error,
        resolution: { error: wiRes.error },
      };
    }
    await cancelPendingLifecycleTimersForTicketKey(sb, ticketKey, "ticket_deleted");
    await appendEventLog({
      traceId,
      log_kind: "portal",
      event: "PORTAL_PM_TICKET_SOFT_DELETED",
      payload: { human_ticket_id: resolvedTicketId, ticket_key: ticketKey },
    });
    return {
      ok: true,
      brain: "portal_ticket_mutation",
      replyText: "Saved: " + resolvedTicketId + " removed (deleted).",
      resolution: { kind: "soft_delete", humanTicketId: resolvedTicketId },
      db: { ticket: "Deleted", work_items: "CANCELED" },
    };
  }

  /** @type {Record<string, unknown>} */
  const ticketPatch = { updated_at: now, last_activity_at: now };
  const f = parsed.fields || {};
  let canonicalStatus = "";

  if (f.statusRaw) {
    canonicalStatus = normalizePortalTicketStatus(String(f.statusRaw));
    if (canonicalStatus) {
      ticketPatch.status = canonicalStatus;
      if (canonicalStatus === "Open") {
        ticketPatch.closed_at = null;
      } else if (canonicalStatus === "Completed" || canonicalStatus === "Deleted") {
        ticketPatch.closed_at = now;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(f, "issue")) {
    ticketPatch.message_raw = f.issue == null ? "" : String(f.issue).trim();
  }
  if (Object.prototype.hasOwnProperty.call(f, "category")) {
    ticketPatch.category = f.category == null ? "" : String(f.category).trim();
  }
  if (Object.prototype.hasOwnProperty.call(f, "serviceNotes")) {
    ticketPatch.service_notes = f.serviceNotes == null ? "" : String(f.serviceNotes).trim();
  }
  /** Parsed schedule + policy + lifecycle — not a raw `preferred_window` string write. */
  let scheduleCommitRaw = "";
  if (Object.prototype.hasOwnProperty.call(f, "preferredWindow")) {
    const pw = f.preferredWindow == null ? "" : String(f.preferredWindow).trim();
    if (pw.length >= 2) {
      scheduleCommitRaw = pw;
    }
  }
  if (Object.prototype.hasOwnProperty.call(f, "urgency")) {
    const u = f.urgency == null ? "" : String(f.urgency).trim();
    ticketPatch.priority = u ? normalizePortalPriority(u) : "normal";
  }

  let unitSyncToWorkItem = "";
  if (Object.prototype.hasOwnProperty.call(f, "unit")) {
    const u = f.unit == null ? "" : String(f.unit).trim();
    if (u) {
      const normalized = normalizeUnit_(u);
      ticketPatch.unit_label = normalized;
      unitSyncToWorkItem = normalized;
    }
  }

  if (f.attachmentsAdd && Array.isArray(f.attachmentsAdd) && f.attachmentsAdd.length) {
    const existing = String((ticket && ticket.attachments) || "").trim();
    const seen = new Set(
      existing
        ? existing
            .split("\n")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        : []
    );
    const lines = existing ? existing.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    for (const u of f.attachmentsAdd) {
      const t = String(u || "").trim();
      if (!t) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(t);
    }
    const joined = lines.join("\n");
    ticketPatch.attachments = joined.length > 3800 ? joined.slice(0, 3800) : joined;
  }

  const { error: tErr2 } = await sb
    .from("tickets")
    .update(ticketPatch)
    .eq("ticket_id", resolvedTicketId);
  if (tErr2) {
    return {
      ok: false,
      brain: "portal_ticket_mutation",
      replyText: "Could not update ticket: " + tErr2.message,
      resolution: { error: tErr2.message },
    };
  }

  if (unitSyncToWorkItem && ticketKey) {
    const wiUnitRes = await updateWorkItemsByTicketKey(sb, ticketKey, {
      unit_id: unitSyncToWorkItem,
      updated_at: now,
    });
    if (!wiUnitRes.ok) {
      return {
        ok: false,
        brain: "portal_ticket_mutation",
        replyText: "Ticket unit updated but work item save failed: " + wiUnitRes.error,
        resolution: { error: wiUnitRes.error },
      };
    }
  }

  /** @type {Record<string, unknown> | null} */
  let wiPatch = null;
  if (canonicalStatus === "Open") {
    wiPatch = {
      status: "OPEN",
      state: "UNSCHEDULED",
      substate: "",
      updated_at: now,
    };
  } else if (canonicalStatus === "Completed") {
    wiPatch = {
      status: "COMPLETED",
      state: "DONE",
      substate: "",
      updated_at: now,
    };
  } else if (canonicalStatus === "Deleted") {
    wiPatch = {
      status: "CANCELED",
      state: "DONE",
      substate: "",
      updated_at: now,
    };
  } else if (canonicalStatus === "In Progress") {
    wiPatch = {
      status: "OPEN",
      state: "IN_PROGRESS",
      substate: "",
      updated_at: now,
    };
  }

  if (wiPatch && ticketKey) {
    const wiRes2 = await updateWorkItemsByTicketKey(sb, ticketKey, wiPatch);
    if (!wiRes2.ok) {
      return {
        ok: false,
        brain: "portal_ticket_mutation",
        replyText: "Ticket updated but work item save failed: " + wiRes2.error,
        resolution: { error: wiRes2.error },
      };
    }
    if (canonicalStatus === "Completed") {
      await cancelPendingLifecycleTimersForTicketKey(sb, ticketKey, "ticket_completed");
    } else if (canonicalStatus === "Deleted") {
      await cancelPendingLifecycleTimersForTicketKey(sb, ticketKey, "ticket_deleted");
    }
  }

  /** Parse + policy + `scheduled_end_at`, then lifecycle (`afterTenantScheduleApplied`) — after WI status patch. */
  let scheduleAppliedLabel = "";
  if (
    scheduleCommitRaw &&
    ticketKey &&
    canonicalStatus !== "Completed" &&
    canonicalStatus !== "Deleted"
  ) {
    const {
      applyPreferredWindowByTicketKey,
      schedulePolicyRejectMessage,
    } = require("./ticketPreferredWindow");
    const { afterTenantScheduleApplied } = require("../brain/lifecycle/afterTenantScheduleApplied");

    const schedRes = await applyPreferredWindowByTicketKey({
      ticketKey,
      preferredWindow: scheduleCommitRaw,
      traceId,
      traceStartMs,
    });

    if (!schedRes.ok) {
      const msg =
        schedRes.error === "policy"
          ? schedulePolicyRejectMessage(schedRes.policyKey, schedRes.policyVars)
          : schedRes.error === "bad_input"
            ? "Could not interpret that time window. Try a clearer day and time (e.g. tomorrow 9–11am)."
            : "Schedule could not be saved: " + String(schedRes.error || "error");
      return {
        ok: false,
        brain: "portal_ticket_mutation",
        replyText: "Ticket updated but schedule was not applied: " + msg,
        resolution: {
          error: schedRes.error,
          policy_key: schedRes.policyKey || null,
          humanTicketId: resolvedTicketId,
        },
      };
    }

    const propHint = String((ticket && ticket.property_code) || "").trim();
    await afterTenantScheduleApplied({
      sb,
      ticketKey,
      parsed: schedRes.parsed || null,
      propertyCodeHint: propHint,
      traceId,
      traceStartMs: traceStartMs != null ? traceStartMs : undefined,
    });

    scheduleAppliedLabel =
      schedRes.parsed && schedRes.parsed.label
        ? String(schedRes.parsed.label).trim()
        : scheduleCommitRaw.slice(0, 120);
  }

  await appendEventLog({
    traceId,
    log_kind: "portal",
    event: "PORTAL_PM_TICKET_UPDATED",
    payload: {
      human_ticket_id: resolvedTicketId,
      lookup_hint: parsed.humanTicketId !== resolvedTicketId ? parsed.humanTicketId : undefined,
      ticket_key: ticketKey,
      fields: f,
      canonical_status: canonicalStatus || undefined,
      attachments_added:
        f.attachmentsAdd && Array.isArray(f.attachmentsAdd) ? f.attachmentsAdd.length : 0,
      schedule_commit: scheduleAppliedLabel ? { applied: true, label: scheduleAppliedLabel } : undefined,
    },
  });

  const bits = [];
  if (canonicalStatus) bits.push("status " + canonicalStatus);
  if (Object.prototype.hasOwnProperty.call(f, "issue")) bits.push("issue");
  if (Object.prototype.hasOwnProperty.call(f, "category")) bits.push("category");
  if (Object.prototype.hasOwnProperty.call(f, "urgency")) bits.push("urgency");
  if (Object.prototype.hasOwnProperty.call(f, "serviceNotes")) bits.push("service notes");
  if (scheduleAppliedLabel) bits.push("schedule " + scheduleAppliedLabel);
  if (Object.prototype.hasOwnProperty.call(f, "unit") && String(f.unit || "").trim()) {
    bits.push("unit " + String(f.unit || "").trim());
  }
  if (f.attachmentsAdd && f.attachmentsAdd.length) bits.push("attachments +" + f.attachmentsAdd.length);
  return {
    ok: true,
    brain: "portal_ticket_mutation",
    replyText: "Saved: " + resolvedTicketId + " (" + (bits.length ? bits.join(", ") : "fields") + ").",
    resolution: { kind: "update", humanTicketId: resolvedTicketId, canonicalStatus },
    db: { ticketPatch, work_items: wiPatch },
  };
}

module.exports = {
  parsePortalPmTicketBody,
  parsePortalPmTicketRequest,
  parseFieldsFromUpdateRest,
  hasUpdatableTicketFields,
  extractPortalPayloadTicketFields,
  flattenPortalPayload,
  pickTicketLookupHintFromFlat,
  pickIssueFromPayload,
  normalizePortalTicketStatus,
  normalizePortalPriority,
  tryPortalPmTicketMutation,
};
