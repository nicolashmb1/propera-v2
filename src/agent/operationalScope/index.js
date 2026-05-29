/**
 * Jarvis Operational Scope — shared "open project" context for all channels.
 * @see docs/PROPERA_JARVIS_NORTH_STAR.md § Operational Scope
 */

const {
  compileOperationalScope,
  buildStoryLine,
  SCOPE_VERSION,
} = require("./compileOperationalScope");
const {
  isPortalChatInbound,
  logOperationalScopeForPortalChat,
} = require("./logOperationalScopeForInbound");

module.exports = {
  compileOperationalScope,
  buildStoryLine,
  SCOPE_VERSION,
  isPortalChatInbound,
  logOperationalScopeForPortalChat,
};
