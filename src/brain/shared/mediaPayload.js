/**
 * Channel-agnostic media bridge for RouterParameter `_mediaJson`.
 * Adapters can populate media metadata/OCR text; core parses one shared shape.
 */

function parseMediaJson(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x === "object");
  } catch (_) {
    return [];
  }
}

function mediaTextHints(mediaList) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(mediaList) ? mediaList : [];

  for (const m of list) {
    const candidates = [
      m && m.ocr_text,
      m && m.ocrText,
      m && m.text,
      m && m.transcript,
      m && m.caption,
    ];
    for (const c of candidates) {
      const t = String(c || "").trim();
      if (!t) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  }

  return out;
}

function composeInboundTextWithMedia(bodyText, mediaList, maxChars) {
  const base = String(bodyText || "").trim();
  const hints = mediaTextHints(mediaList);
  const budget = isFinite(Number(maxChars)) ? Math.max(0, Number(maxChars)) : 1400;

  const blocks = [];
  if (base) blocks.push(base);
  if (hints.length) blocks.push(hints.join("\n"));

  const combined = blocks.join("\n").trim();
  if (!combined) return "";
  if (combined.length <= budget) return combined;
  return combined.slice(0, budget).trim();
}

module.exports = {
  parseMediaJson,
  mediaTextHints,
  composeInboundTextWithMedia,
};
