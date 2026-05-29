/**
 * Short relative time strings for Jarvis Ask (operator-readable).
 */

/**
 * @param {string|Date|null|undefined} iso
 */
function formatAgeBrief(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!isFinite(t)) return "";
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 8) return `${wk}w ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * @param {unknown} timelineJson
 * @param {number} [max]
 */
function pickRecentTimeline(timelineJson, max) {
  const limit = max == null ? 5 : Math.max(0, max);
  let rows = timelineJson;
  if (typeof rows === "string") {
    try {
      rows = JSON.parse(rows);
    } catch (_) {
      rows = [];
    }
  }
  if (!Array.isArray(rows)) return [];
  const parsed = rows
    .map((e) => {
      const action = String(e?.action || e?.headline || "").trim();
      const by = String(e?.by || "").trim();
      const at = e?.at || e?.occurred_at || "";
      const kind = String(e?.kind || "").trim();
      if (!action && !kind) return null;
      return {
        action: action || kind,
        by,
        at,
        age: formatAgeBrief(at),
      };
    })
    .filter(Boolean);
  return parsed.slice(-limit).reverse();
}

module.exports = { formatAgeBrief, pickRecentTimeline };
