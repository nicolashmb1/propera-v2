/**
 * Channel-agnostic OCR enrichment orchestrator.
 * Adapter-specific code provides `ocrOne(mediaItem)` so core remains transport-neutral.
 */

async function enrichMediaWithOcr(mediaList, opts) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  if (!opts || !opts.enabled || typeof opts.ocrOne !== "function") return list;

  const out = [];
  for (const m of list) {
    const item = Object.assign({}, m || {});
    const kind = String(item.kind || "").toLowerCase();
    const existing = String(item.ocr_text || item.text || "").trim();
    if (existing || (kind !== "image" && kind !== "file")) {
      out.push(item);
      continue;
    }
    try {
      const ocr = await opts.ocrOne(item);
      const txt = String(ocr || "").trim();
      if (txt) item.ocr_text = txt.slice(0, 1800);
    } catch (_) {}
    out.push(item);
  }
  return out;
}

module.exports = { enrichMediaWithOcr };
