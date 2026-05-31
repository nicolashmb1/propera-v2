/**
 * Structured portal / PM UI → GAS `e.parameter` shape for `runInboundPipeline`.
 * Does not persist tickets — brain + finalize own writes.
 *
 * @param {object} payload — JSON from POST `/webhooks/portal`
 * @returns {Record<string, string>}
 */

const { postCreateNone } = require("./postCreateContract");

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

function normalizePortalChatMediaItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const o = { ...raw };
  let k = String(o.kind != null ? o.kind : "image").trim().toLowerCase();
  if (k === "voice" || k === "voice_note") k = "audio";
  o.kind = k;
  if (k === "audio") {
    const sp = String(o.storagePath || "").trim();
    const mime = String(o.mimeType || o.mime_type || "").trim();
    if (!sp) {
      throw new Error("buildRouterParameterFromPortal: portal_chat audio requires storagePath");
    }
    if (!mime) {
      throw new Error("buildRouterParameterFromPortal: portal_chat audio requires mimeType or mime_type");
    }
    o.storagePath = sp;
    o.mime_type = mime;
    if (!o.mimeType) o.mimeType = mime;
  }
  return o;
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
  /** @type {string} */
  let mediaJson = "";

  const portalChannel = String(p.channel || "").trim().toLowerCase();
  const portalActorType = String(p.actor_type || p.actorType || "").trim().toUpperCase();
  const isTenantPortalStructured =
    portalChannel === "tenant_portal" || portalActorType === "TENANT";

  if (action === "create_ticket") {
    if (isTenantPortalStructured) {
      /** Structured signal only — brain uses `_portalPayloadJson`, not NL parse on Body. */
      body = "noop";
    } else {
      const prop = String(p.property || p.property_code || "").trim();
      const unit = String(p.unit || p.unit_label || "").trim();
      const cat = String(p.category || "").trim();
      const msg = String(p.message || p.description || "").trim();
      const pw = String(p.preferredWindow || "").trim();
      const lk = String(
        p.location_kind != null ? p.location_kind : p.locationKind != null ? p.locationKind : "unit"
      )
        .trim()
        .toLowerCase();
      const isCommonLike = lk === "common_area" || lk === "property" || lk === "commonarea";
      if (isCommonLike) {
        body = `# ${prop} ${cat}: ${msg}`.replace(/\s+/g, " ").trim();
      } else {
        body = `# ${prop} apt ${unit} ${cat}: ${msg}`.replace(/\s+/g, " ").trim();
      }
      if (pw) body += "\nPreferred: " + pw.trim();
    }
  } else if (action === "portal_chat") {
    /**
     * Propera app command bar — adapter only. Client sends final text (e.g. `#…` for staff capture)
     * and optional `media[]` (`dataUrl` MVP). Same pipeline as other portal ingress.
     */
    const raw =
      p.body !== undefined && p.body !== null
        ? p.body
        : p.message !== undefined && p.message !== null
          ? p.message
          : "";
    body = String(raw).trim();
    const mediaArr = Array.isArray(p.media)
      ? p.media.filter((x) => x && typeof x === "object")
      : [];
    const normalizedMedia = [];
    for (const x of mediaArr) {
      const n = normalizePortalChatMediaItem(x);
      if (n) normalizedMedia.push(n);
    }
    mediaJson = normalizedMedia.length ? JSON.stringify(normalizedMedia) : "";
    if (!body && normalizedMedia.length === 0) {
      throw new Error("buildRouterParameterFromPortal: portal_chat requires body/message or media");
    }
    if (!body && normalizedMedia.length > 0) {
      const portalMode = String(p.portal_chat_mode || "staff_capture").trim().toLowerCase();
      if (portalMode === "staff_capture") {
        throw new Error(
          'buildRouterParameterFromPortal: portal_chat media-only requires body "#" (staff capture)'
        );
      }
    }
  } else {
    body = String(p.body || "").trim();
    if (!body && portalPostImpliesPmTicketSave(p)) body = "noop";
  }

  if (!body && !mediaJson) {
    throw new Error("buildRouterParameterFromPortal: empty body");
  }

  const portalChatMode =
    action === "portal_chat"
      ? String(p.portal_chat_mode || p.portalChatMode || "").trim().toLowerCase()
      : "";

  const costCtx = p.portal_cost_context ?? p.portalCostContext;
  const costCtxJson =
    costCtx && typeof costCtx === "object" ? JSON.stringify(costCtx) : "";

  const proposalCtx = p.portal_proposal_context ?? p.portalProposalContext;
  const proposalCtxJson =
    proposalCtx && typeof proposalCtx === "object" ? JSON.stringify(proposalCtx) : "";

  const pageCtx = p.portal_page_context ?? p.portalPageContext;
  const pageCtxJson =
    pageCtx && typeof pageCtx === "object" ? JSON.stringify(pageCtx) : "";

  const financialCtx = p.portal_financial_context ?? p.portalFinancialContext;
  const financialCtxJson =
    financialCtx && typeof financialCtx === "object" ? JSON.stringify(financialCtx) : "";

  const payloadForJson =
    action === "create_ticket"
      ? {
          ...p,
          postCreate:
            p.postCreate && typeof p.postCreate === "object"
              ? p.postCreate
              : postCreateNone(),
        }
      : p;

  return {
    _mode: "",
    _internal: "",
    _channel: "PORTAL",
    _phoneE164: actor,
    From: actor,
    Body: body,
    _mediaJson: mediaJson,
    _portalAction: action,
    _portalPayloadJson: JSON.stringify(payloadForJson),
    _portalChannel: portalChannel || (isTenantPortalStructured ? "tenant_portal" : ""),
    _portalActorType: portalActorType,
    _tenantPhoneE164: String(p.tenantPhoneE164 || p.phone || actor).trim(),
    _portalChatMode: portalChatMode,
    _portalCostContextJson: costCtxJson,
    _portalProposalContextJson: proposalCtxJson,
    _portalPageContextJson: pageCtxJson,
    _portalFinancialContextJson: financialCtxJson,
  };
}

module.exports = { buildRouterParameterFromPortal, portalPostImpliesPmTicketSave };
