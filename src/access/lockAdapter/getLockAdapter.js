const { noopAdapter } = require("./noopAdapter");

/**
 * @param {string} provider
 */
function getLockAdapter(provider) {
  const p = String(provider || "noop").toLowerCase();
  if (p === "noop") return noopAdapter;
  throw new Error(`lock_adapter_not_implemented:${p}`);
}

module.exports = { getLockAdapter };
