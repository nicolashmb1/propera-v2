/**
 * Portal Jarvis Plan mode detection.
 */

/**
 * @param {Record<string, string | undefined>} routerParameter
 */
function isPortalJarvisPlanMode(routerParameter) {
  return (
    String(routerParameter._portalChatMode || "")
      .trim()
      .toLowerCase() === "jarvis_plan"
  );
}

module.exports = { isPortalJarvisPlanMode };
