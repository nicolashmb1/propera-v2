/**
 * Accumulate inbound `_mediaJson` across multi-turn gather so handoff retains photos
 * sent on earlier turns (e.g. photo on turn 1, property/unit on later turns).
 */
const { parseMediaJson } = require("../../brain/shared/mediaPayload");

/**
 * @param {object} item
 * @returns {string}
 */
function mediaItemDedupeKey(item) {
  if (!item || typeof item !== "object") return "";
  const url = String(item.url || item.file_url || item.fileUrl || "").trim().toLowerCase();
  if (url) return "url:" + url;
  const provider = String(item.provider || "").trim().toLowerCase();
  const fileId = String(item.file_id || "").trim();
  if (provider && fileId) return provider + ":" + fileId;
  const fileName = String(item.file_name || "").trim().toLowerCase();
  if (fileName) return "file:" + fileName;
  return "";
}

/**
 * @param {...unknown[]} lists
 * @returns {object[]}
 */
function mergeMediaItems(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const k = mediaItemDedupeKey(item);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/**
 * @param {...string} jsonStrings
 * @returns {string}
 */
function mergeMediaJsonStrings(...jsonStrings) {
  const lists = jsonStrings.map((s) => parseMediaJson(s));
  const merged = mergeMediaItems(...lists);
  return merged.length ? JSON.stringify(merged) : "";
}

/**
 * @param {object} partial
 * @returns {string}
 */
function readGatheredMediaJson(partial) {
  return String((partial && partial._gathered_media_json) || "").trim();
}

/**
 * @param {object} partial
 * @param {string} inboundMediaJson
 * @returns {object}
 */
function accumulatePartialPackageMedia(partial, inboundMediaJson) {
  const pkg = { ...(partial || {}) };
  const incoming = parseMediaJson(inboundMediaJson);
  if (!incoming.length) return pkg;
  const merged = mergeMediaItems(parseMediaJson(readGatheredMediaJson(pkg)), incoming);
  if (merged.length) {
    pkg._gathered_media_json = JSON.stringify(merged);
  }
  return pkg;
}

/**
 * @param {object} partial
 * @param {string} inboundMediaJson
 * @returns {string}
 */
function resolveHandoffMediaJson(partial, inboundMediaJson) {
  return mergeMediaJsonStrings(readGatheredMediaJson(partial), inboundMediaJson);
}

module.exports = {
  mediaItemDedupeKey,
  mergeMediaItems,
  mergeMediaJsonStrings,
  readGatheredMediaJson,
  accumulatePartialPackageMedia,
  resolveHandoffMediaJson,
};
