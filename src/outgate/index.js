/**
 * Outgate — Phase 1: intent → render → dispatch (single seam).
 */

const { buildOutboundIntent } = require("./outboundIntent");
const { renderOutboundIntent } = require("./renderOutboundIntent");
const { dispatchOutbound } = require("./dispatchOutbound");

module.exports = {
  buildOutboundIntent,
  renderOutboundIntent,
  dispatchOutbound,
};
