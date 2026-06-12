const { noopAdapter } = require("./noopAdapter");
const { seamAdapter } = require("./seamAdapter");

/**
 * @param {string} provider
 */
function getLockAdapter(provider) {
  const p = String(provider || "noop").toLowerCase();
  if (p === "noop") return noopAdapter;
  if (p === "seam") return seamAdapter;
  throw new Error(`lock_adapter_not_implemented:${p}`);
}

module.exports = { getLockAdapter };
