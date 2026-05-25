/**
 * Collect attachment URL tokens from inbound _mediaJson for append packages.
 */
const { parseMediaJson } = require("../../brain/shared/mediaPayload");

/**
 * @param {string} mediaJson
 * @returns {string[]}
 */
function extractAttachmentUrlsFromMediaJson(mediaJson) {
  const items = parseMediaJson(mediaJson);
  const urls = [];
  for (const m of items) {
    if (!m || typeof m !== "object") continue;
    const url = String(
      m.url || m.publicUrl || m.storagePath || m.storage_path || ""
    ).trim();
    if (url) urls.push(url);
  }
  return urls;
}

module.exports = { extractAttachmentUrlsFromMediaJson };
