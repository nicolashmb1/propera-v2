/**
 * Translate canonical DB text for tenant portal display (read path).
 * @see docs/TENANT_PORTAL_I18N.md Phase 3
 */
const { tenantI18nEnabled } = require("../config/env");
const { normalizeTenantUiLocale } = require("./tenantI18nLocale");
const { detectLanguage } = require("./detectTextLanguage");
const { translateForDisplay } = require("./translateTenantText");

/**
 * @param {string} text
 * @param {"en"|"es"} uiLocale
 * @param {string} [traceId]
 * @returns {Promise<string|null>} display string if different from source, else null
 */
async function displayTextIfNeeded(text, uiLocale, traceId) {
  const raw = String(text || "").trim();
  if (!raw || uiLocale !== "es" || !tenantI18nEnabled()) return null;

  const detected = detectLanguage(raw);
  if (detected === "es") return null;

  const tr = await translateForDisplay({
    text: raw,
    targetLocale: "es",
    sourceLocale: detected === "en" ? "en" : "en",
    traceId,
  });
  if (!tr.ok || !tr.text || tr.text === raw) return null;
  return tr.text;
}

/**
 * @param {object} ticket
 * @param {string} [preferredLanguage]
 * @param {string} [traceId]
 */
async function applyDisplayToTenantTicket(ticket, preferredLanguage, traceId) {
  const uiLocale = normalizeTenantUiLocale(preferredLanguage);
  if (uiLocale !== "es" || !tenantI18nEnabled()) return ticket;

  const out = { ...ticket };

  const [titleDisplay, descriptionDisplay, serviceNotesDisplay] = await Promise.all([
    displayTextIfNeeded(ticket.title, uiLocale, traceId),
    displayTextIfNeeded(ticket.description, uiLocale, traceId),
    displayTextIfNeeded(ticket.serviceNotes, uiLocale, traceId),
  ]);

  if (titleDisplay) out.titleDisplay = titleDisplay;
  if (descriptionDisplay) out.descriptionDisplay = descriptionDisplay;
  if (serviceNotesDisplay) out.serviceNotesDisplay = serviceNotesDisplay;

  if (Array.isArray(ticket.timeline) && ticket.timeline.length > 0) {
    out.timeline = await Promise.all(
      ticket.timeline.map(async (ev) => {
        const actionDisplay = await displayTextIfNeeded(ev.action, uiLocale, traceId);
        if (!actionDisplay) return ev;
        return { ...ev, actionDisplay };
      })
    );
  }

  return out;
}

/**
 * @param {object[]} tickets
 */
async function applyDisplayToTenantTickets(tickets, preferredLanguage, traceId) {
  const uiLocale = normalizeTenantUiLocale(preferredLanguage);
  if (uiLocale !== "es" || !tenantI18nEnabled()) return tickets;
  return Promise.all(
    tickets.map((t) => applyDisplayToTenantTicket(t, preferredLanguage, traceId))
  );
}

/**
 * @param {object} notice
 */
async function applyDisplayToTenantNotice(notice, preferredLanguage, traceId) {
  const uiLocale = normalizeTenantUiLocale(preferredLanguage);
  if (uiLocale !== "es" || !tenantI18nEnabled()) return notice;

  const [titleDisplay, messageBodyDisplay] = await Promise.all([
    displayTextIfNeeded(notice.title, uiLocale, traceId),
    displayTextIfNeeded(notice.messageBody, uiLocale, traceId),
  ]);

  const out = { ...notice };
  if (titleDisplay) out.titleDisplay = titleDisplay;
  if (messageBodyDisplay) out.messageBodyDisplay = messageBodyDisplay;
  return out;
}

async function applyDisplayToTenantNotices(notices, preferredLanguage, traceId) {
  const uiLocale = normalizeTenantUiLocale(preferredLanguage);
  if (uiLocale !== "es" || !tenantI18nEnabled()) return notices;
  return Promise.all(
    notices.map((n) => applyDisplayToTenantNotice(n, preferredLanguage, traceId))
  );
}

module.exports = {
  displayTextIfNeeded,
  applyDisplayToTenantTicket,
  applyDisplayToTenantTickets,
  applyDisplayToTenantNotice,
  applyDisplayToTenantNotices,
};
