/**
 * Portal Jarvis Ask mode detection.
 */

/**
 * @param {Record<string, string | undefined>} routerParameter
 */
function isPortalJarvisAskMode(routerParameter) {
  return (
    String(routerParameter._portalChatMode || "")
      .trim()
      .toLowerCase() === "jarvis_ask"
  );
}

module.exports = { isPortalJarvisAskMode };
