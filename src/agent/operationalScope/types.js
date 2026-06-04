/**
 * Operational Scope — Jarvis "open project" context (hints + candidates, not brain truth).
 * @see docs/PROPERA_JARVIS_NORTH_STAR.md § Operational Scope
 */

/**
 * @typedef {'staff' | 'owner' | 'tenant' | 'unknown'} OperationalActorRole
 */

/**
 * @typedef {object} OperationalScopeActor
 * @property {OperationalActorRole} role
 * @property {string} [staffId]
 * @property {string} [actorKey] — conversation / channel key (e.g. E.164)
 * @property {string} [transportChannel]
 */

/**
 * @typedef {object} OperationalScopeAnchor
 * @property {string} [surface]
 * @property {string} [pathname]
 * @property {string} [propertyCode]
 * @property {string} [unit]
 * @property {string} [unitCatalogId]
 * @property {string} [turnoverId]
 * @property {string} [ticketRowId]
 * @property {string} [humanTicketId]
 * @property {string} [ticketLabel]
 */

/**
 * @typedef {object} OperationalScopeActiveOccupancy
 * @property {string} occupancyId
 * @property {string} [residentName]
 * @property {string} [status]
 * @property {string} [startedAt]
 */

/**
 * @typedef {object} OperationalScopeActiveTurnover
 * @property {string} turnoverId
 * @property {string} [status]
 * @property {string} [startedAt]
 * @property {string} [targetReadyDate]
 * @property {string} [unitLabel]
 */

/**
 * @typedef {object} OperationalScopeUnitAssetSummary
 * @property {string} assetId
 * @property {string} [assetType]
 * @property {string} [make]
 * @property {string} [model]
 * @property {string} [serialNumber]
 */

/**
 * @typedef {object} OperationalScopeUnitLifecycle
 * @property {string} unitCatalogId
 * @property {OperationalScopeActiveOccupancy | null} activeOccupancy
 * @property {OperationalScopeActiveTurnover | null} activeTurnover
 * @property {string} turnoverBlocker
 * @property {OperationalScopeUnitAssetSummary[]} unitAssets
 */

/**
 * @typedef {object} OperationalScopeWorkItem
 * @property {string} workItemId
 * @property {string} [propertyId]
 * @property {string} [unitId]
 * @property {string} [ticketHumanId]
 * @property {string} [ticketKey]
 * @property {string} [state]
 */

/**
 * @typedef {object} OperationalScopeOpenTicket
 * @property {string} ticketRowId
 * @property {string} [humanTicketId]
 * @property {string} [propertyCode]
 * @property {string} [unitLabel]
 * @property {string} [status]
 * @property {string} [summary]
 */

/**
 * @typedef {object} OperationalScopeFocus
 * @property {string} [workItemId]
 * @property {string} [ticketRowId]
 * @property {string} [humanTicketId]
 * @property {string} [reason] — e.g. PAGE_CONTEXT_HUMAN_TICKET
 */

/**
 * @typedef {object} OperationalScope
 * @property {string} version — schema version
 * @property {string} compiledAt — ISO timestamp
 * @property {OperationalScopeActor} actor
 * @property {OperationalScopeAnchor} anchor
 * @property {OperationalScopeWorkItem[]} activeWork
 * @property {OperationalScopeOpenTicket[]} propertyOpenTickets
 * @property {OperationalScopeFocus | null} focus
 * @property {OperationalScopeUnitLifecycle | null} [unitLifecycle]
 * @property {string} story — short deterministic narrative for LLM / templates
 */

module.exports = {};
