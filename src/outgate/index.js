/**
 * Outgate — Phase 1: intent → render → dispatch (single seam).
 */

const { buildOutboundIntent } = require("./outboundIntent");
const { renderOutboundIntent } = require("./renderOutboundIntent");
const { renderForChannel } = require("./renderForChannel");
const { dispatchOutbound } = require("./dispatchOutbound");

module.exports = {
  buildOutboundIntent,
  renderOutboundIntent,
  renderForChannel,
  dispatchOutbound,
};
