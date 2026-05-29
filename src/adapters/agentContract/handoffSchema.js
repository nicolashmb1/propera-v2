/**
 * Agent <-> brain handoff schema (Piece 1 of the access foundation).
 *
 * The contract at the seam — NOT a constraint on how the agent gathers.
 *
 *   GATHER ZONE                       HANDOFF ZONE (this file)
 *   LLM is completely free.           Contract is strict.
 *   "saturday not sunday" works.      startAt: ISO with offset
 *   "2-4 this afternoon" works.       locationId: UUID, never a name
 *   Corrections work.                 intentType: closed set
 *   Asks follow-ups freely.           dateForDay: closed hint token
 *
 * When `validateAccessHandoff` rejects a payload, the brain returns
 * `brain: "access_needs_more"` with the primary `kickback_intent`.
 * The agent stores that on `_access_last_error` so the LLM sees on the
 * next turn what's missing and asks naturally. The LLM never becomes
 * regex-like — it stays in conversation; the seam stays in math.
 *
 * Doctrine:
 *  - Principle 6 (AI is interpretation/expression, not control)
 *  - Guardrail 15 (Preserve strict separation of layers)
 *  - Guardrail 22 (Make everything explicit)
 */

const { ACCESS_INTENT_TYPES } = require("../../access/parseAccessIntent");

const ACCESS_HANDOFF_INTENTS = new Set([
  ACCESS_INTENT_TYPES.RESERVE,
  ACCESS_INTENT_TYPES.LIST_SLOTS,
  ACCESS_INTENT_TYPES.CANCEL,
  ACCESS_INTENT_TYPES.STATUS,
]);

/**
 * Minimal kickback vocabulary. Grow as pieces 2-4 surface real cases.
 * The agent prompt teaches the LLM what to ask for when each fires.
 */
const KICKBACK_INTENTS = Object.freeze({
  NEED_INTENT: "need_intent",
  NEED_LOCATION: "need_location",
  NEED_WINDOW: "need_window",
  NEED_DATE: "need_date",
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_HINT_RE =
  /^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})$/i;

const ISO_OFFSET_RE = /T[0-9:.]+(Z|[+-]\d{2}:?\d{2})$/;

/** @param {unknown} s */
function isUuid(s) {
  return UUID_RE.test(String(s || "").trim());
}

/** @param {unknown} s */
function isDateHintToken(s) {
  return DATE_HINT_RE.test(String(s || "").trim());
}

/**
 * Strict ISO check — must include explicit offset or Z. Plain `new Date()`
 * accepts ambiguous strings; we don't.
 * @param {unknown} s
 */
function isIsoInstant(s) {
  const t = String(s || "").trim();
  if (!t || !ISO_OFFSET_RE.test(t)) return false;
  const d = new Date(t);
  return Number.isFinite(d.getTime());
}

/**
 * @typedef {object} HandoffError
 * @property {string} field           Offending field name.
 * @property {string} kickback        One of KICKBACK_INTENTS.
 * @property {string} message         Human-readable reason for logs.
 */

/**
 * Validate an agent -> brain handoff payload against the contract.
 * @param {object | null | undefined} raw
 * @returns {{ ok: boolean, errors: HandoffError[] }}
 */
function validateAccessHandoff(raw) {
  /** @type {HandoffError[]} */
  const errors = [];
  const p = raw && typeof raw === "object" ? raw : {};

  const intent = String(p.intentType || "").trim();

  if (!intent || !ACCESS_HANDOFF_INTENTS.has(intent)) {
    errors.push({
      field: "intentType",
      kickback: KICKBACK_INTENTS.NEED_INTENT,
      message: "intentType is required and must be one of the closed access intent set.",
    });
    return { ok: false, errors };
  }

  const requiresLocation =
    intent === ACCESS_INTENT_TYPES.RESERVE ||
    intent === ACCESS_INTENT_TYPES.LIST_SLOTS;

  if (requiresLocation) {
    if (!isUuid(p.locationId)) {
      errors.push({
        field: "locationId",
        kickback: KICKBACK_INTENTS.NEED_LOCATION,
        message: "locationId must be a resolved UUID — not a name or slug.",
      });
    }
  }

  if (intent === ACCESS_INTENT_TYPES.RESERVE) {
    if (!isDateHintToken(p.dateForDay)) {
      errors.push({
        field: "dateForDay",
        kickback: KICKBACK_INTENTS.NEED_DATE,
        message:
          "dateForDay must be a hint token (today, tomorrow, weekday name, or YYYY-MM-DD).",
      });
    }
    const startOk = isIsoInstant(p.startAt);
    const endOk = isIsoInstant(p.endAt);
    if (!startOk || !endOk) {
      errors.push({
        field: "startAt/endAt",
        kickback: KICKBACK_INTENTS.NEED_WINDOW,
        message:
          "startAt and endAt must be ISO 8601 with explicit offset or Z (the resolver emits this shape).",
      });
    } else {
      const s = new Date(p.startAt).getTime();
      const e = new Date(p.endAt).getTime();
      if (!(e > s)) {
        errors.push({
          field: "endAt",
          kickback: KICKBACK_INTENTS.NEED_WINDOW,
          message: "endAt must be strictly after startAt.",
        });
      }
    }
  }

  if (intent === ACCESS_INTENT_TYPES.LIST_SLOTS) {
    if (!isDateHintToken(p.dateForDay)) {
      errors.push({
        field: "dateForDay",
        kickback: KICKBACK_INTENTS.NEED_DATE,
        message:
          "dateForDay must be a hint token (today, tomorrow, weekday name, or YYYY-MM-DD).",
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Pick the most actionable kickback for the agent to react to first.
 * Ordering reflects gather-loop dependency: you can't ask for a window
 * before knowing the location, etc.
 *
 * @param {HandoffError[]} errors
 * @returns {string}
 */
function primaryKickbackIntent(errors) {
  if (!Array.isArray(errors) || !errors.length) return "";
  const order = [
    KICKBACK_INTENTS.NEED_INTENT,
    KICKBACK_INTENTS.NEED_LOCATION,
    KICKBACK_INTENTS.NEED_DATE,
    KICKBACK_INTENTS.NEED_WINDOW,
  ];
  for (const kb of order) {
    if (errors.some((e) => e.kickback === kb)) return kb;
  }
  return String(errors[0].kickback || "");
}

/**
 * Human-readable summary for logs and event_log payloads.
 * @param {HandoffError[]} errors
 * @returns {string}
 */
function summarizeHandoffErrors(errors) {
  if (!Array.isArray(errors) || !errors.length) return "";
  return errors.map((e) => `${e.field}: ${e.message}`).join(" | ");
}

module.exports = {
  ACCESS_HANDOFF_INTENTS,
  KICKBACK_INTENTS,
  validateAccessHandoff,
  primaryKickbackIntent,
  summarizeHandoffErrors,
  isUuid,
  isDateHintToken,
  isIsoInstant,
};
