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

/**
 * Telegram often puts staff draft handles in the **photo caption** (`#`, `#d126`) while the
 * maintenance narrative is in OCR / screenshot. Drop routing-only captions so `composeInboundTextWithMedia`
 * does not treat `#` as the only issue line (parity with GAS-style “caption = handle, image = body”).
 *
 * @param {unknown} caption — raw `msg.caption` copied onto media items
 * @returns {string} issue-sized tail for hints, or "" if caption is only a staff hash / draft id
 */
function issueHintFromTelegramPhotoCaption(caption) {
  const t = String(caption != null ? caption : "").trim();
  if (!t) return "";
  // Pure "#", optional spaces, optional draft id only — not issue text.
  if (/^\s*#\s*(?:[dD]\d+)?\s*$/i.test(t)) return "";
  if (/^\s*#\s*staff\s*$/i.test(t)) return "";
  const staffAlias = t.match(/^\s*#\s*staff\b\s*[:\-]?\s*(.+)$/i);
  if (staffAlias) return String(staffAlias[1] || "").trim();
  // "#d126 …issue…" / "# …issue…" — keep trailing prose only.
  const m = t.match(/^\s*#\s*(?:[dD]\d+)?\s+(.+)$/is);
  if (m) return String(m[1] || "").trim();
  return t;
}

function signalIssueConfidence(sig) {
  const c = sig && sig.confidence && typeof sig.confidence === "object"
    ? Number(sig.confidence.issue)
    : 0;
  return isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
}

function mediaSignalTextHints(mediaSignals) {
  const out = [];
  const list = Array.isArray(mediaSignals) ? mediaSignals : [];

  for (const sig of list) {
    if (!sig || typeof sig !== "object") continue;
    const ocr = String(sig.ocrText || sig.ocr_text || "").trim();
    if (ocr) out.push(ocr);

    const strongIssue = !sig.needsClarification && signalIssueConfidence(sig) >= 0.55;
    if (!strongIssue) continue;

    const synthetic = String(sig.syntheticBody || "").trim();
    if (synthetic) {
      out.push(synthetic);
      continue;
    }

    const name = String(sig.issueNameHint || "").trim();
    const desc = String(sig.issueDescriptionHint || "").trim();
    if (name && desc && desc.toLowerCase().indexOf(name.toLowerCase()) === -1) {
      out.push(name + ": " + desc);
    } else {
      out.push(desc || name);
    }
  }

  return out;
}

function mediaTextHints(mediaList, mediaSignals) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(mediaList) ? mediaList : [];
  const signalHints = mediaSignalTextHints(mediaSignals);

  for (const m of list) {
    const capHint = issueHintFromTelegramPhotoCaption(m && m.caption);
    const candidates = [
      m && m.ocr_text,
      m && m.ocrText,
      m && m.text,
      m && m.transcript,
      capHint || null,
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

  for (const c of signalHints) {
    const t = String(c || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }

  return out;
}

function composeInboundTextWithMedia(bodyText, mediaList, maxChars, mediaSignals) {
  const base = String(bodyText || "").trim();
  const hints = mediaTextHints(mediaList, mediaSignals);
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
  issueHintFromTelegramPhotoCaption,
  mediaSignalTextHints,
  mediaTextHints,
  composeInboundTextWithMedia,
};
