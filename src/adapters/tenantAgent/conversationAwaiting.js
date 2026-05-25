/**
 * Awaiting state — what the agent last asked the tenant.
 *
 * Stored in partial_package._awaiting so no DB schema change is required.
 *
 * Doctrine: when an awaiting state is active, the tenant is answering a specific
 * question. The turn handler skips generic classification and routes the reply
 * directly to the relevant slot handler.
 */
const AWAITING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string} type
 * @param {object} [context]
 * @returns {{ type: string, expires_at: string, context: object }}
 */
function buildAwaiting(type, context) {
  return {
    type: String(type),
    expires_at: new Date(Date.now() + AWAITING_TTL_MS).toISOString(),
    context: context && typeof context === "object" ? context : {},
  };
}

/**
 * @param {object|null|undefined} partial
 * @returns {{ type: string, expires_at: string, context: object } | null}
 */
function getAwaiting(partial) {
  const a = partial && partial._awaiting;
  if (!a || !a.type) return null;
  if (a.expires_at) {
    try {
      if (new Date(a.expires_at) < new Date()) return null;
    } catch (_) {
      return null;
    }
  }
  return a;
}

/**
 * @param {object|null|undefined} partial
 * @param {string|string[]} types
 * @returns {boolean}
 */
function awaitingIs(partial, types) {
  const a = getAwaiting(partial);
  if (!a) return false;
  const set = Array.isArray(types) ? types : [types];
  return set.includes(a.type);
}

/**
 * @param {object} partial
 * @param {string} type
 * @param {object} [context]
 * @returns {object}
 */
function setAwaiting(partial, type, context) {
  return {
    ...(partial || {}),
    _awaiting: buildAwaiting(type, context),
  };
}

/**
 * @param {object} partial
 * @returns {object}
 */
function clearAwaiting(partial) {
  const p = { ...(partial || {}) };
  delete p._awaiting;
  return p;
}

module.exports = {
  buildAwaiting,
  getAwaiting,
  awaitingIs,
  setAwaiting,
  clearAwaiting,
};
