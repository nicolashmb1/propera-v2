/**
 * Structured portal / PM UI → GAS `e.parameter` shape for `runInboundPipeline`.
 * Does not persist tickets — brain + finalize own writes.
 *
 * @param {object} payload — JSON from POST `/webhooks/portal`
 * @returns {Record<string, string>}
 */

/** Keep in sync with `dal/portalTicketMutations.js` PORTAL_PAYLOAD_NEST_KEYS. */
const PORTAL_PAYLOAD_NEST_KEYS = [
  "ticket",
  "row",
  "data",
  "payload",
  "patch",
  "changes",
  "updates",
  "fields",
  "edits",
  "ticketPatch",
];

function assignDefinedShallow(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const k of Object.keys(source)) {
    if (source[k] !== undefined) target[k] = source[k];
  }
}

/**
 * @param {object} p
 * @returns {Record<string, unknown>}
 */
function flattenPortalPostForHint(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return {};
  const merged = { ...p };
  for (const nk of PORTAL_PAYLOAD_NEST_KEYS) {
    assignDefinedShallow(merged, p[nk]);
  }
  return merged;
}

/**
 * True when JSON carries a ticket id plus at least one mutable field — PM apps often
 * omit `body` and rely on `_portalPayloadJson` for `portalTicketMutations`.
 * @param {object} p
 */
function portalPostImpliesPmTicketSave(p) {
  const flat = flattenPortalPostForHint(p);
  const idKeys = ["ticket_id", "humanTicketId", "ticketId", "id"];
  const hasTicketId = idKeys.some(
    (k) =>
      Object.prototype.hasOwnProperty.call(flat, k) && String(flat[k] || "").trim()
  );
  if (!hasTicketId) return false;
  const fieldKeys = [
    "message_raw",
    "messageRaw",
    "issue",
    "issueText",
    "message",
    "summary",
    "status",
    "category",
    "urgency",
    "priority",
    "serviceNote",
    "serviceNotes",
    "preferredWindow",
    "preferred_window",
    "schedule",
    /** PM app add-photo: array of URLs merged in `portalTicketMutations` */
    "attachments",
    "attachmentUrls",
  ];
  return fieldKeys.some((k) => Object.prototype.hasOwnProperty.call(flat, k));
}

/**
 * @param {unknown} payload
 * @returns {object}
 */
function normalizePortalPostPayload(payload) {
  if (Array.isArray(payload) && payload.length > 0 && typeof payload[0] === "object" && payload[0]) {
    return { ticket: payload[0] };
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload;
  return {};
}

function buildRouterParameterFromPortal(payload) {
  const p = normalizePortalPostPayload(payload);
  const action = String(p.action || "staff_command").trim().toLowerCase();
  const actor = String(
    p.actorPhoneE164 || p.phoneE164 || p.actorPhone || ""
  ).trim();
  if (!actor) {
    throw new Error("buildRouterParameterFromPortal: missing actorPhoneE164");
  }

  let body = "";

  if (action === "create_ticket") {
    const prop = String(p.property || "").trim();
    const unit = String(p.unit || "").trim();
    const cat = String(p.category || "").trim();
    const msg = String(p.message || "").trim();
    const pw = String(p.preferredWindow || "").trim();
    body = `# ${prop} apt ${unit} ${cat}: ${msg}`.replace(/\s+/g, " ").trim();
    if (pw) body += "\nPreferred: " + pw.trim();
  } else {
    body = String(p.body || "").trim();
    if (!body && portalPostImpliesPmTicketSave(p)) body = "noop";
  }

  if (!body) {
    throw new Error("buildRouterParameterFromPortal: empty body");
  }

  return {
    _mode: "",
    _internal: "",
    _channel: "PORTAL",
    _phoneE164: actor,
    From: actor,
    Body: body,
    _mediaJson: "",
    _portalAction: action,
    _portalPayloadJson: JSON.stringify(p),
    _tenantPhoneE164: String(p.tenantPhoneE164 || "").trim(),
  };
}

module.exports = { buildRouterParameterFromPortal };
